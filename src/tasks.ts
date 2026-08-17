/**
 * The keeper's upkeep tasks.
 *
 * Every one is idempotent and permissionless. Running a task twice, or running two
 * keepers at once, is harmless: the contract refuses what is not due, and the second
 * attempt simply fails with a reason. That property is what makes the keeper replaceable
 * rather than trusted — anyone can run one, and nobody has to.
 */

import type { Keeper } from "./client.ts";
import type { KeeperConfig } from "./config.ts";

export interface TaskOutcome {
  task: string;
  did: "nothing" | "work";
  detail: string;
  /**
   * When this task next has something to do, in epoch milliseconds.
   *
   * The window tasks do not run on a cadence the operator invents — the contract publishes
   * the exact second each one falls due, so the keeper can wait for that moment instead of
   * polling for it. Absent when nothing is pending, which means nothing can fall due until
   * a user transaction creates it, and anything so created is days away.
   */
  nextDue?: number;
}

const nothing = (task: string, detail: string, nextDue?: number): TaskOutcome => ({
  task,
  did: "nothing",
  detail,
  nextDue,
});

/**
 * Refresh cached totals from the staking module.
 *
 * The most important task the keeper runs. Deposits and withdrawal requests are both
 * refused while the cache is stale, so letting it lapse takes the protocol offline for
 * users even though nothing is wrong with it.
 *
 * Paginated, so a full sweep may take several transactions; freshness is only stamped once
 * the last one lands.
 */
export async function sync(keeper: Keeper, config: KeeperConfig): Promise<TaskOutcome> {
  const before = await keeper.state();

  let calls = 0;
  // Bounded so a misconfigured page limit cannot spin forever.
  for (let i = 0; i < 20; i++) {
    const result = await keeper.execute({ sync: { limit: config.pageLimit } });
    calls++;
    if (!result.ok) {
      return { task: "sync", did: "work", detail: `failed after ${calls}: ${result.error}` };
    }
    const state = await keeper.state();
    if (!state.is_unattended) {
      return {
        task: "sync",
        did: "work",
        detail: `fresh after ${calls} call(s), bonded ${state.total_bonded}`,
      };
    }
  }

  return {
    task: "sync",
    did: "work",
    detail: `still stale after ${calls} calls — was ${before.last_sync_time}`,
  };
}

/**
 * Harvest rewards, take the protocol's cut, restake the rest.
 *
 * Paginated over the validator set for the same gas reason as `sync`.
 */
export async function compound(keeper: Keeper, config: KeeperConfig): Promise<TaskOutcome> {
  let calls = 0;
  let harvested = 0n;

  for (let i = 0; i < 20; i++) {
    const result = await keeper.execute({ compound: { limit: config.pageLimit } });
    calls++;
    if (!result.ok) {
      return {
        task: "compound",
        did: calls > 1 ? "work" : "nothing",
        detail: `failed after ${calls}: ${result.error}`,
      };
    }

    // The contract reports `done` in its response data, but reading it back through the
    // state query is simpler and equally conclusive: a finished sweep leaves no pending
    // rewards and a fresh cache.
    const state = await keeper.state();
    harvested = BigInt(state.pending_rewards);
    if (!state.is_unattended && harvested === 0n) {
      return { task: "compound", did: "work", detail: `swept in ${calls} call(s)` };
    }
  }

  return { task: "compound", did: "work", detail: `incomplete after ${calls} calls` };
}

/**
 * Close the open window if its time has come.
 *
 * Closing late is safe — it widens the spacing between unbonding entries, which is the
 * direction that keeps the protocol under the chain's limit. Closing early is impossible;
 * the contract refuses. So a keeper that is a few minutes behind costs users a few minutes,
 * and a keeper that is early costs nothing at all.
 */
export async function advanceWindow(keeper: Keeper): Promise<TaskOutcome> {
  const open = (await keeper.windows("open"))[0];
  if (!open) {
    return nothing("advance-window", "no open window");
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < open.closes_at) {
    const mins = Math.ceil((open.closes_at - now) / 60);
    return nothing(
      "advance-window",
      `window ${open.id} closes in ${mins} min`,
      open.closes_at * 1000,
    );
  }

  const result = await keeper.execute({ advance_window: {} });
  return result.ok
    ? { task: "advance-window", did: "work", detail: `closed window ${open.id}` }
    : { task: "advance-window", did: "work", detail: `failed: ${result.error}` };
}

/** Mark windows whose unbonding period has elapsed as claimable. */
export async function collectMatured(
  keeper: Keeper,
  config: KeeperConfig,
): Promise<TaskOutcome> {
  const unbonding = await keeper.windows("unbonding");
  const now = Math.floor(Date.now() / 1000);
  const due = unbonding.filter((w) => now >= w.matures_at);

  if (due.length === 0) {
    const next = unbonding
      .map((w) => w.matures_at)
      .sort((a, b) => a - b)[0];
    return nothing(
      "collect-matured",
      next ? `next matures in ${Math.ceil((next - now) / 3600)} h` : "nothing unbonding",
      next === undefined ? undefined : next * 1000,
    );
  }

  const result = await keeper.execute({ collect_matured: { limit: config.pageLimit } });
  return result.ok
    ? {
        task: "collect-matured",
        did: "work",
        detail: `collected ${due.length} window(s): ${due.map((w) => w.id).join(", ")}`,
      }
    : { task: "collect-matured", did: "work", detail: `failed: ${result.error}` };
}
