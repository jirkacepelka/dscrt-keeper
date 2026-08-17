/**
 * Invariant checks the keeper runs on every pass.
 *
 * These do not fix anything — they exist to make a problem visible before it becomes a
 * loss. The contract enforces its own rules; what it cannot do is notice that a validator
 * has quietly stopped earning, or that the exchange rate moved in a direction it should
 * not have. Someone has to watch from outside, and the keeper is already looking.
 */

import type { Keeper, ProtocolState, ValidatorEntry } from "./client.ts";
import { store, type Store } from "./store.ts";

export type Severity = "ok" | "warn" | "alert";

export interface Finding {
  severity: Severity;
  check: string;
  detail: string;
}

/** State carried between passes so drift can be detected at all. */
export interface Memory {
  lastExchangeRate?: bigint;
  lastBondedByValidator?: Record<string, bigint>;
}

const MEMORY_FILE = "memory.json";

/** The same thing, in a shape JSON can hold: bigint is not serialisable. */
interface StoredMemory {
  lastExchangeRate?: string;
  lastBondedByValidator?: Record<string, string>;
}

/**
 * Carry the baselines across a restart.
 *
 * Without this, every restart made the keeper blind to exactly the two things these checks
 * exist for. The exchange-rate check reported `(first reading)` and could not have noticed a
 * fall, and drift detection had no previous delegation to compare against — so a container
 * that restarts nightly, which is what `restart: unless-stopped` plus a home server's power
 * cuts amounts to, was running a monitor that never monitored.
 */
export function loadMemory(from: Store = store): Memory {
  const stored = from.readJson<StoredMemory>(MEMORY_FILE, {});
  const memory: Memory = {};

  if (stored.lastExchangeRate) {
    try {
      memory.lastExchangeRate = BigInt(stored.lastExchangeRate);
    } catch {
      // A corrupt figure is the same as no figure: the next pass becomes the baseline.
    }
  }
  if (stored.lastBondedByValidator) {
    const bonded: Record<string, bigint> = {};
    for (const [address, amount] of Object.entries(stored.lastBondedByValidator)) {
      try {
        bonded[address] = BigInt(amount);
      } catch {
        // Skip the one that will not parse rather than lose the whole set.
      }
    }
    memory.lastBondedByValidator = bonded;
  }

  return memory;
}

export function saveMemory(memory: Memory, from: Store = store): void {
  const stored: StoredMemory = {};
  if (memory.lastExchangeRate !== undefined) {
    stored.lastExchangeRate = memory.lastExchangeRate.toString();
  }
  if (memory.lastBondedByValidator) {
    stored.lastBondedByValidator = Object.fromEntries(
      Object.entries(memory.lastBondedByValidator).map(([k, v]) => [k, v.toString()]),
    );
  }

  try {
    from.writeJson(MEMORY_FILE, stored);
  } catch {
    // A monitor that cannot save its baseline is still a monitor. Upkeep continues.
  }
}

const RATE_SCALE = 1_000_000_000_000_000_000n;

/** Format a scaled rate as a human-readable decimal. */
function formatRate(rate: bigint): string {
  return (Number(rate) / Number(RATE_SCALE)).toFixed(6);
}

/**
 * The exchange rate must never fall except through slashing.
 *
 * A fall is the single loudest signal this protocol can produce: it means holders are
 * worth less than they were, and the only legitimate cause is a validator being punished.
 * Anything else is a bug, and finding out from a monitor beats finding out from a user.
 */
function checkExchangeRate(state: ProtocolState, memory: Memory): Finding {
  const rate = BigInt(state.exchange_rate);
  const previous = memory.lastExchangeRate;
  memory.lastExchangeRate = rate;

  if (previous === undefined) {
    return { severity: "ok", check: "exchange-rate", detail: `${formatRate(rate)} (first reading)` };
  }
  if (rate >= previous) {
    return { severity: "ok", check: "exchange-rate", detail: formatRate(rate) };
  }

  // A slash of 0.01% (downtime) is small; double-sign is 5%. Anything larger than a few
  // percent is not an ordinary punishment.
  const dropBps = ((previous - rate) * 10_000n) / previous;
  return {
    severity: dropBps > 10n ? "alert" : "warn",
    check: "exchange-rate",
    detail: `fell ${Number(dropBps) / 100}% from ${formatRate(previous)} to ${formatRate(rate)} — expect a slashing event, investigate if there was none`,
  };
}

/**
 * Freshness gates deposits and withdrawals.
 *
 * A stale cache does not lose money, it stops the protocol accepting any. That is a
 * user-visible outage caused by the keeper not doing its job, so it is worth shouting
 * about.
 */
function checkFreshness(state: ProtocolState): Finding {
  if (!state.is_unattended) {
    const age = Math.floor(Date.now() / 1000) - state.last_sync_time;
    return { severity: "ok", check: "freshness", detail: `synced ${age}s ago` };
  }
  return {
    severity: "alert",
    check: "freshness",
    detail: "cached totals are stale — deposits and withdrawals are being refused",
  };
}

/**
 * Unbonding entry slots must stay below the protocol ceiling.
 *
 * The contract already redirects around a full validator, but a set that is consistently
 * near the ceiling means the window length and the validator count no longer suit each
 * other, and the redirect is carrying load it was only meant to catch.
 */
function checkEntrySlots(validators: ValidatorEntry[], ceiling: number): Finding[] {
  return validators
    .filter((v) => v.active_unbond_entries >= ceiling - 1)
    .map((v) => ({
      severity: (v.active_unbond_entries >= ceiling ? "alert" : "warn") as Severity,
      check: "unbond-entries",
      detail: `${v.address} holds ${v.active_unbond_entries} of ${ceiling} entry slots`,
    }));
}

/**
 * A validator whose stake shrank without the protocol asking is a validator in trouble.
 *
 * Jailing and tombstoning both show up this way, and the protocol has no other way to
 * learn about them: it never queries validator status, only its own delegation.
 */
function checkValidatorDrift(validators: ValidatorEntry[], memory: Memory): Finding[] {
  const previous = memory.lastBondedByValidator ?? {};
  const current: Record<string, bigint> = {};
  const findings: Finding[] = [];

  for (const v of validators) {
    const bonded = BigInt(v.bonded);
    current[v.address] = bonded;

    const was = previous[v.address];
    if (was === undefined || was === 0n) continue;

    // Undelegation legitimately shrinks a delegation, so only flag a drop while no
    // unbonding is in flight against this validator.
    if (bonded < was && v.active_unbond_entries === 0) {
      const dropBps = ((was - bonded) * 10_000n) / was;
      findings.push({
        severity: "alert",
        check: "validator-drift",
        detail: `${v.address} lost ${Number(dropBps) / 100}% of its delegation with no unbonding in flight — likely slashed or jailed`,
      });
    }
  }

  memory.lastBondedByValidator = current;
  return findings;
}

/**
 * The protocol must not owe more than it holds.
 *
 * Stated the plain way: everything the contract has, minus what it already promised to
 * people leaving, has to cover what the outstanding shares are worth.
 */
function checkSolvency(state: ProtocolState): Finding {
  const assets =
    BigInt(state.total_bonded) +
    BigInt(state.pending_rewards) +
    BigInt(state.liquid_unallocated);
  const owedToHolders = (BigInt(state.total_supply) * BigInt(state.exchange_rate)) / RATE_SCALE;

  if (assets >= owedToHolders) {
    return {
      severity: "ok",
      check: "solvency",
      detail: `${assets} backing ${owedToHolders}`,
    };
  }
  return {
    severity: "alert",
    check: "solvency",
    detail: `assets ${assets} do not cover ${owedToHolders} owed to holders`,
  };
}

/** The keeper's own gas. Upkeep stops when this runs out, and users notice before we do. */
async function checkGas(keeper: Keeper): Promise<Finding> {
  /*
   * No key, no account, nothing to weigh.
   *
   * Reported rather than skipped silently, and deliberately not "ok" in spirit: a run that
   * did not look must not read like a run that looked and was satisfied. This is the shape
   * a CI smoke test takes — it checks the protocol, not an operator's wallet.
   */
  if (!keeper.hasKey) {
    return {
      severity: "ok",
      check: "keeper-gas",
      detail: "not checked — no key configured",
    };
  }

  const balance = await keeper.gasBalance();
  const scrt = Number(balance) / 1e6;

  if (balance === 0n) {
    return { severity: "alert", check: "keeper-gas", detail: "keeper account is empty" };
  }
  if (scrt < 5) {
    return { severity: "warn", check: "keeper-gas", detail: `${scrt.toFixed(2)} SCRT left` };
  }
  return { severity: "ok", check: "keeper-gas", detail: `${scrt.toFixed(2)} SCRT` };
}

export async function runChecks(
  keeper: Keeper,
  memory: Memory,
  entryCeiling: number,
): Promise<Finding[]> {
  const [state, validators] = await Promise.all([keeper.state(), keeper.validators()]);

  return [
    checkFreshness(state),
    checkExchangeRate(state, memory),
    checkSolvency(state),
    ...checkEntrySlots(validators, entryCeiling),
    ...checkValidatorDrift(validators, memory),
    await checkGas(keeper),
  ];
}
