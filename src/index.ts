#!/usr/bin/env node
/**
 * Upkeep loop for the SCRT liquid staking protocol.
 *
 * Three jobs on independent schedules, plus a health check on every pass:
 *
 *   sync            keeps cached totals fresh, which is what lets users transact at all
 *   compound        harvests rewards, takes the protocol's cut, restakes the remainder
 *   window upkeep   closes a window when its time comes, collects matured ones
 *
 * None of it is privileged. Anyone can run this, and if nobody does, the protocol does not
 * lose money — it stops accepting deposits once the cache goes stale, and yield stops
 * compounding. That is the failure mode a keeper exists to avoid, and it is deliberately
 * an inconvenience rather than a loss.
 */

import { Keeper } from "./client.ts";
import { loadConfig, type KeeperConfig } from "./config.ts";
import { runChecks, type Finding, type Memory } from "./invariants.ts";
import { advanceWindow, collectMatured, compound, sync, type TaskOutcome } from "./tasks.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(level: "info" | "warn" | "error", message: string, extra?: object) {
  // One JSON object per line: greppable by a human, ingestible by anything else.
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra })}\n`,
  );
}

function report(findings: Finding[]) {
  for (const f of findings) {
    if (f.severity === "ok") {
      log("info", f.check, { detail: f.detail });
    } else {
      log(f.severity === "alert" ? "error" : "warn", f.check, { detail: f.detail });
    }
  }
}

function logOutcome(outcome: TaskOutcome) {
  log(outcome.did === "work" ? "info" : "info", outcome.task, {
    did: outcome.did,
    detail: outcome.detail,
  });
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
class Schedule {
  private lastRun = 0;
  private deadline = Number.POSITIVE_INFINITY;
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  due(now: number): boolean {
    return now >= Math.min(this.lastRun + this.intervalMs, this.deadline);
  }

  /** Record a run. `deadline` is epoch ms; omitting it falls back to the interval alone. */
  mark(now: number, deadline?: number) {
    this.lastRun = now;
    this.deadline = deadline ?? Number.POSITIVE_INFINITY;
  }
}

/** The earliest real deadline among a set of outcomes, if any of them named one. */
function soonest(outcomes: TaskOutcome[]): number | undefined {
  const dates = outcomes
    .map((o) => o.nextDue)
    .filter((d): d is number => typeof d === "number");
  return dates.length === 0 ? undefined : Math.min(...dates);
}

async function pass(
  keeper: Keeper,
  config: KeeperConfig,
  memory: Memory,
  schedules: { compound: Schedule; window: Schedule },
): Promise<"healthy" | "unhealthy" | void> {
  const now = Date.now();

  // Health first: if the cache is stale the sync schedule is beside the point, and if the
  // exchange rate just fell an operator wants to know before anything else happens.
  const findings = await runChecks(keeper, memory, /* entryCeiling */ 6);
  report(findings);

  // A check run reports through its exit code as well as its logs, so a container health
  // probe or a cron job can tell "ran" from "ran and everything is fine". Without it the
  // keeper looked healthy while sitting on an account too empty to pay for anything.
  if (config.checkOnly) {
    return findings.some((f) => f.severity === "alert") ? "unhealthy" : "healthy";
  }

  if (schedules.window.due(now)) {
    const outcomes = [await advanceWindow(keeper), await collectMatured(keeper, config)];
    for (const outcome of outcomes) logOutcome(outcome);
    schedules.window.mark(now, soonest(outcomes));
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
  if (stale || schedules.compound.due(now)) {
    const outcome = await compound(keeper, config);
    logOutcome(outcome);
    schedules.compound.mark(now);

    /*
     * Fall back to a plain sync if that failed and left the figures stale.
     *
     * Compound is the larger transaction — it withdraws, delegates and mints — so it has
     * more ways to fail than a sync does. When it does, the published rate should not be
     * held hostage to whatever broke the harvest.
     */
    if (stale && outcome.detail.startsWith("failed")) {
      logOutcome(await sync(keeper, config));
    }
  }
}

async function main() {
  const config = loadConfig();
  const keeper = new Keeper(config);

  log("info", "keeper starting", {
    // A keyless run is legitimate — `--check-only` sends nothing — so this reports the
    // absence rather than demanding a mnemonic in order to print a line.
    address: keeper.hasKey ? keeper.address : "(no key — read only)",
    contract: config.contract,
    chain: config.chainId,
    mode: config.checkOnly ? "check-only" : config.once ? "single pass" : "loop",
  });

  // Anything that sends transactions needs a key, and finding that out now beats finding
  // it out after the first pass has already queried the chain.
  if (!config.checkOnly && !keeper.hasKey) {
    throw new Error("KEEPER_MNEMONIC is not set. See .env.example.");
  }

  const memory: Memory = {};
  const schedules = {
    compound: new Schedule(config.compoundIntervalMs),
    window: new Schedule(config.windowIntervalMs),
  };

  if (config.once || config.checkOnly) {
    const verdict = await pass(keeper, config, memory, schedules);
    if (verdict === "unhealthy") process.exitCode = 1;
    return;
  }

  // The loop never exits on error. A keeper that dies on a transient RPC failure is worse
  // than one that logs it and tries again in a minute, because the failure it is meant to
  // prevent is precisely "nobody ran the upkeep".
  for (;;) {
    try {
      await pass(keeper, config, memory, schedules);
    } catch (e) {
      log("error", "pass failed", {
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    await sleep(60_000);
  }
}

main().catch((e) => {
  log("error", "fatal", { detail: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
