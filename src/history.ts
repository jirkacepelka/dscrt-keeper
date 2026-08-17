/**
 * What the keeper has actually done.
 *
 * Until now the answer was "read the Docker log and hope it has not rotated". Every
 * transaction the keeper sent returned a hash and every caller dropped it on the floor, so
 * there was no way to ask what a keeper had spent, what it had sent, or whether the thing
 * that failed last Tuesday failed the same way twice.
 *
 * **Only real events are recorded.** A pass that found nothing due is not an operation, and
 * writing one every sixty seconds would produce fourteen hundred lines a day that say
 * nothing and bury the twenty that do. Skips stay in the stdout log where they belong;
 * this file holds transactions, failures, and the handful of moments an operator changed
 * something.
 *
 * One JSON object per line, so it can be appended without reading, tailed by a human, and
 * eaten by anything else. No database: the keeper has one dependency and this is not worth
 * a second.
 */

import { store, type Store } from "./store.ts";

const FILE = "history.jsonl";

/**
 * The cap, and what happens at it.
 *
 * Compacted rather than rotated to a second file, because a history split across two files
 * is a history the console has to reassemble, and the older half is the half nobody reads.
 * At roughly 200 bytes a line this is about a megabyte, and at hourly compounding it is
 * around seven months of transactions.
 */
const MAX_LINES = 5_000;
const KEEP_ON_COMPACT = 4_000;

export type Outcome = "ok" | "failed";

export interface Entry {
  /** ISO 8601, UTC. */
  ts: string;
  /**
   * `tx` is something that went to the chain. `event` is something the operator or the
   * process did — a setting changed, a key replaced, a start.
   */
  kind: "tx" | "event";
  /** `compound`, `sync`, `advance-window`, `collect-matured`, `config`, `wallet`, `start`. */
  task: string;
  outcome: Outcome;
  /** The same sentence the stdout log carries, in the words a person would use. */
  detail: string;
  txHash?: string;
  height?: number;
  gasUsed?: number;
  gasWanted?: number;
  /**
   * What the transaction cost, in uscrt.
   *
   * Cosmos charges the fee you declare, not the gas you burn, so this is `gasWanted` times
   * the gas price and not `gasUsed`. Reporting the cheaper of the two would understate the
   * bill by whatever margin the gas estimate carries, which is the entire point of watching
   * it.
   */
  feeUscrt?: number;
  error?: string;
}

export class History {
  private readonly store: Store;
  private lines: number;

  constructor(from: Store = store) {
    this.store = from;
    this.lines = this.read().length;
  }

  /**
   * Append one entry.
   *
   * Failures to write are swallowed on purpose. The keeper's job is upkeep; an unwritable
   * volume must degrade the record, never the work. It is reported once through the
   * console's own "cannot save" state rather than by killing the process.
   */
  add(entry: Omit<Entry, "ts"> & { ts?: string }): Entry {
    const full: Entry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    try {
      this.store.appendText(FILE, `${JSON.stringify(full)}\n`);
      this.lines++;
      if (this.lines > MAX_LINES) this.compact();
    } catch {
      // Nothing to do that is better than carrying on.
    }
    return full;
  }

  /** Newest first, which is the order anybody wants to read it in. */
  read(): Entry[] {
    const raw = this.store.readText(FILE);
    if (!raw) return [];

    const entries: Entry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as Entry);
      } catch {
        // A torn last line after a power cut. Skip it and keep the rest — the alternative
        // is throwing away every transaction ever recorded over one bad byte.
      }
    }
    return entries.reverse();
  }

  /** Newest first, filtered and paged for the console. */
  page(options: { task?: string; outcome?: Outcome; limit?: number; offset?: number } = {}): {
    entries: Entry[];
    total: number;
  } {
    const { task, outcome, limit = 50, offset = 0 } = options;

    let entries = this.read();
    if (task) entries = entries.filter((e) => e.task === task);
    if (outcome) entries = entries.filter((e) => e.outcome === outcome);

    return { entries: entries.slice(offset, offset + limit), total: entries.length };
  }

  /** Totals the console shows above the table, so a cost is a figure rather than a feeling. */
  summary(): { sent: number; failed: number; spentUscrt: number; since: string | null } {
    const entries = this.read().filter((e) => e.kind === "tx");
    const last = entries[entries.length - 1];

    return {
      sent: entries.filter((e) => e.outcome === "ok").length,
      failed: entries.filter((e) => e.outcome === "failed").length,
      spentUscrt: entries.reduce((total, e) => total + (e.feeUscrt ?? 0), 0),
      since: last?.ts ?? null,
    };
  }

  private compact() {
    const kept = this.read().slice(0, KEEP_ON_COMPACT).reverse();
    this.store.writeText(FILE, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
    this.lines = kept.length;
  }
}

/**
 * The fee a transaction actually cost.
 *
 * `gasPrice` arrives as the string the chain wants — `"0.025uscrt"` — so the denom is
 * stripped rather than parsed. Rounded up, because a fee is charged in whole uscrt.
 */
export function feeFor(gasWanted: number, gasPrice: string): number {
  const price = Number(gasPrice.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(price)) return 0;
  return Math.ceil(gasWanted * price);
}
