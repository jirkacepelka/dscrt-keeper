/**
 * Everything the keeper knows right now.
 *
 * Gathered into one object so the console can read live truth — the actual schedules, the
 * actual findings from the last pass — rather than a second copy of the same reasoning that
 * drifts from the first. Two implementations of "is a compound due" is one more than this
 * protocol can keep honest.
 *
 * Kept apart from `index.ts` so the server can import it without importing a module whose
 * top level starts a keeper.
 */

import { Keeper } from "./client.ts";
import { formatDuration, resolveSettings, type KeeperConfig } from "./config.ts";
import { feeFor, History } from "./history.ts";
import { loadMemory, runChecks, saveMemory, type Finding, type Memory } from "./invariants.ts";
import { hasKey } from "./secrets.ts";
import { advanceWindow, collectMatured, compound, sync, type TaskOutcome } from "./tasks.ts";

export function log(level: "info" | "warn" | "error", message: string, extra?: object) {
  // One JSON object per line: greppable by a human, ingestible by anything else.
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra })}\n`,
  );
}

/** The tasks the console can ask for by name, in the order a full sweep runs them. */
export const TASKS = ["advance-window", "collect-matured", "compound", "sync"] as const;
export type TaskName = (typeof TASKS)[number];

export function isTaskName(value: string): value is TaskName {
  return (TASKS as readonly string[]).includes(value);
}

/**
 * Whether a job is due.
 *
 * Deliberately not a cron: the keeper may be restarted at any time, and a schedule that
 * depends on wall-clock alignment would either double up or skip a slot on every restart.
 * Elapsed time since the last successful run is restart-safe.
 *
 * The interval is a ceiling rather than a cadence. Where the chain publishes the second a
 * job actually falls due — a window's `closes_at`, a maturity date — `mark` is given that
 * deadline and the job wakes for it instead of being discovered up to an interval late.
 * The ceiling still applies, because a user transaction can create work the last check had
 * no way to see.
 */
export class Schedule {
  private lastRun = 0;
  private deadline = Number.POSITIVE_INFINITY;
  private intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  due(now: number): boolean {
    return now >= this.nextAt;
  }

  /** When this job next comes round, in epoch ms. What the console counts down to. */
  get nextAt(): number {
    return Math.min(this.lastRun + this.intervalMs, this.deadline);
  }

  /**
   * Retune without restarting.
   *
   * The whole reason the console lives in this process rather than beside it: changing the
   * compound interval from six-hourly to hourly should move the next run, not require a
   * container restart that also throws away everything the schedule already knows.
   */
  retune(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** Record a run. `deadline` is epoch ms; omitting it falls back to the interval alone. */
  mark(now: number, deadline?: number) {
    this.lastRun = now;
    this.deadline = deadline ?? Number.POSITIVE_INFINITY;
  }
}

/** The earliest real deadline among a set of outcomes, if any of them named one. */
function soonest(outcomes: TaskOutcome[]): number | undefined {
  const dates = outcomes.map((o) => o.nextDue).filter((d): d is number => typeof d === "number");
  return dates.length === 0 ? undefined : Math.min(...dates);
}

export class Runtime {
  config: KeeperConfig;
  keeper: Keeper;
  readonly history = new History();
  readonly startedAt = Date.now();

  private memory: Memory = loadMemory();
  private readonly schedules: { compound: Schedule; window: Schedule };

  /** The last pass's findings and per-task outcomes, for the console's overview. */
  findings: Finding[] = [];
  outcomes = new Map<string, TaskOutcome>();
  lastPassAt: number | null = null;
  lastError: string | null = null;

  constructor(config: KeeperConfig) {
    this.config = config;
    this.keeper = new Keeper(config);
    this.schedules = {
      compound: new Schedule(config.compoundIntervalMs),
      window: new Schedule(config.windowIntervalMs),
    };
  }

  nextDue(): { compound: number; window: number } {
    return { compound: this.schedules.compound.nextAt, window: this.schedules.window.nextAt };
  }

  /**
   * Adopt settings that changed underneath the process.
   *
   * The client is rebuilt rather than mutated because a new chain id or endpoint means a
   * different `SecretNetworkClient` and a code hash that must be resolved again — patching
   * those in place is how you end up querying one chain with another's cached hash. The
   * schedules are retuned in place, because their elapsed time is worth keeping.
   */
  reconfigure(): KeeperConfig {
    const { settings } = resolveSettings();
    this.config = { ...this.config, ...settings };
    this.keeper = new Keeper(this.config);
    this.schedules.compound.retune(this.config.compoundIntervalMs);
    this.schedules.window.retune(this.config.windowIntervalMs);

    log("info", "configuration reloaded", {
      chain: this.config.chainId,
      contract: this.config.contract,
      compound: formatDuration(this.config.compoundIntervalMs),
      window: formatDuration(this.config.windowIntervalMs),
    });
    return this.config;
  }

  /** Run one named task now, whatever the schedule thinks. */
  async runTask(name: TaskName): Promise<TaskOutcome> {
    const outcome = await (name === "compound"
      ? compound(this.keeper, this.config)
      : name === "sync"
        ? sync(this.keeper, this.config)
        : name === "advance-window"
          ? advanceWindow(this.keeper)
          : collectMatured(this.keeper, this.config));

    this.outcomes.set(outcome.task, outcome);
    this.record(outcome);
    return outcome;
  }

  /**
   * Log an outcome, and write the transactions it produced to the ledger.
   *
   * One ledger entry per transaction rather than per task: a paginated sweep is several
   * transactions with several hashes and several fees, and a row whose hash column shows
   * only the first of them is a row that cannot be checked against an explorer.
   *
   * Skips are not recorded. A pass that found nothing due is not an operation, and writing
   * one every sixty seconds would bury the twenty lines a year that matter.
   */
  record(outcome: TaskOutcome) {
    const failed = outcome.error !== undefined;
    // Failures used to be logged at `info` through a ternary whose branches were identical,
    // so a keeper failing every task looked, to anything reading levels, exactly like one
    // that was working.
    log(failed ? "warn" : "info", outcome.task, {
      did: outcome.did,
      detail: outcome.detail,
      ...(outcome.receipts?.length ? { txs: outcome.receipts.map((r) => r.txHash) } : {}),
    });

    const receipts = outcome.receipts ?? [];
    receipts.forEach((receipt, i) => {
      this.history.add({
        kind: "tx",
        task: outcome.task,
        outcome: "ok",
        detail:
          receipts.length > 1
            ? `${outcome.detail} (call ${i + 1} of ${receipts.length})`
            : outcome.detail,
        txHash: receipt.txHash,
        height: receipt.height,
        gasUsed: receipt.gasUsed,
        gasWanted: receipt.gasWanted,
        feeUscrt: feeFor(receipt.gasWanted, this.config.gasPrice),
      });
    });

    if (failed) {
      this.history.add({
        kind: "tx",
        task: outcome.task,
        outcome: "failed",
        detail: outcome.detail,
        error: outcome.error,
      });
    }
  }

  /** Something an operator did, rather than something the chain did. */
  note(task: string, detail: string) {
    log("info", task, { detail });
    this.history.add({ kind: "event", task, outcome: "ok", detail });
  }

  async pass(): Promise<"healthy" | "unhealthy" | void> {
    const now = Date.now();

    // Health first: if the cache is stale the sync schedule is beside the point, and if the
    // exchange rate just fell an operator wants to know before anything else happens.
    const findings = await runChecks(this.keeper, this.memory, /* entryCeiling */ 6);
    this.findings = findings;
    this.lastPassAt = now;
    this.lastError = null;

    for (const f of findings) {
      if (f.severity === "ok") log("info", f.check, { detail: f.detail });
      else log(f.severity === "alert" ? "error" : "warn", f.check, { detail: f.detail });
    }

    // A check run reports through its exit code as well as its logs, so a container health
    // probe or a cron job can tell "ran" from "ran and everything is fine". Without it the
    // keeper looked healthy while sitting on an account too empty to pay for anything.
    //
    // It returns before saving anything, deliberately: this is the health probe, it may run
    // against a read-only filesystem with no volume at all, and a probe that creates a data
    // directory as a side effect of looking is a probe that changes what it measures.
    if (this.config.checkOnly) {
      return findings.some((f) => f.severity === "alert") ? "unhealthy" : "healthy";
    }

    saveMemory(this.memory);

    /*
     * Nothing is sent without a key.
     *
     * The keeper now starts before anybody has configured one — the console exists partly so
     * somebody can supply it — so the loop reaches this point on a first run with no way to
     * sign. Attempting the tasks anyway produced a ledger full of "failed: no key", which is
     * a record of the keeper's own configuration rather than of anything that happened to
     * the protocol. The checks above still ran, and still report.
     */
    if (!hasKey()) return;

    if (this.schedules.window.due(now)) {
      const outcomes = [
        await advanceWindow(this.keeper),
        await collectMatured(this.keeper, this.config),
      ];
      for (const outcome of outcomes) {
        this.outcomes.set(outcome.task, outcome);
        this.record(outcome);
      }
      this.schedules.window.mark(now, soonest(outcomes));
    }

    /*
     * Compound carries the cache.
     *
     * There is no separate sync pass because there is nothing left for one to do: the
     * contract's `Compound` re-reads every validator's real delegation and restamps
     * `last_sync_time` on a completed sweep, harvest or no harvest. Two jobs were paying
     * twice for one of them.
     */
    const stale = findings.some((f) => f.check === "freshness" && f.severity !== "ok");
    if (stale || this.schedules.compound.due(now)) {
      const outcome = await compound(this.keeper, this.config);
      this.outcomes.set(outcome.task, outcome);
      this.record(outcome);
      this.schedules.compound.mark(now);

      /*
       * Fall back to a plain sync if that failed and left the figures stale.
       *
       * Compound is the larger transaction — it withdraws, delegates and mints — so it has
       * more ways to fail than a sync does. When it does, the published rate should not be
       * held hostage to whatever broke the harvest.
       */
      if (stale && outcome.error !== undefined) {
        const fallback = await sync(this.keeper, this.config);
        this.outcomes.set(fallback.task, fallback);
        this.record(fallback);
      }
    }
  }
}
