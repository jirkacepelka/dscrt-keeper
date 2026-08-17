/**
 * Keeper configuration.
 *
 * The keeper is deliberately unprivileged. Every task it performs is a permissionless
 * message that anyone could send, so its key needs gas and nothing else: losing it costs
 * the operator some SCRT and stalls upkeep until a replacement runs, but it cannot move
 * user funds, change the fee, or touch the validator set. Nothing here should ever be
 * given the manager's key.
 *
 * ## Where a value comes from
 *
 * Three layers, and the order matters: **environment, then the saved file, then the
 * compiled default.** The environment wins.
 *
 * That direction is not the obvious one — the console is the newer, friendlier way to set
 * things, so it is tempting to let it override — but a setting screen that accepts a value
 * the process will not use is a setting screen that lies. An operator who pinned `LCD_URL`
 * in their compose file gets `LCD_URL`, and the console shows that field as set by the
 * environment and refuses to edit it, rather than saving something into `config.json` that
 * quietly never takes effect.
 */

import { readKey } from "./secrets.ts";
import { store, type Store } from "./store.ts";

const FILE = "config.json";

/**
 * Everything the console is allowed to write.
 *
 * Deliberately not the whole of `KeeperConfig`: `--once` and `--check-only` are how the
 * process was invoked, not settings, and the mnemonic is handled by `secrets.ts` because
 * it must never travel back out the way the rest of this does.
 */
export interface Settings {
  chainId: string;
  lcdUrl: string;
  contract: string;
  /** Empty means "ask the chain". See `Keeper.codeHash`. */
  contractCodeHash: string;
  compoundIntervalMs: number;
  windowIntervalMs: number;
  /** In uscrt. Zero means harvest whatever is there. */
  compoundFloor: number;
  pageLimit: number;
  /** Zero means size it from the validator set. */
  gasLimit: number;
  gasPrice: string;
}

export interface KeeperConfig extends Settings {
  /**
   * Read on demand, not at startup.
   *
   * `--check-only` sends nothing — it reads the protocol and reports whether the figures
   * hold — so demanding a signing key before it will run was asking for a credential to
   * perform a query. It also made the health probe impossible to run anywhere that has no
   * business holding one, which is most places worth running it from.
   */
  mnemonic: () => string;

  /** Exit after a single pass instead of looping. Useful under an external scheduler. */
  once: boolean;
  /** Run the invariant checks and report, without sending anything. */
  checkOnly: boolean;
}

export type Source = "env" | "file" | "default";
export type Provenance = Record<keyof Settings, Source>;

/*
 * Defaults are the live dSCRT deployment, so running this against the protocol it was
 * written for takes a mnemonic and nothing else.
 *
 * They previously named `secret-4` and a mainnet node. There is no mainnet deployment, so
 * those defaults pointed at a contract that does not exist — a default that cannot work is
 * worse than no default, because it fails somewhere further from the cause.
 */
export const DEFAULTS: Settings = {
  chainId: "pulsar-3",
  lcdUrl: "https://pulsar.lcd.secretnodes.com",
  contract: "secret1lj23n74aan7nlgj6hfm45fh3gc7h2ctdplsw8y",
  contractCodeHash: "",

  /*
   * Hourly, and it is the only thing on a clock.
   *
   * `Compound` re-reads every validator from the staking module and restamps
   * `last_sync_time` whether or not it found anything to harvest, so it does everything
   * `Sync` did and harvests as well. Running both was paying twice for one of them.
   *
   * Hourly is not about yield. Rewards accrue continuously and harvesting only moves them,
   * so compounding 24 times a day rather than 4 is worth a rounding error on the APY. What
   * it buys is a published exchange rate that is never more than an hour behind the chain,
   * for a gas bill small enough not to argue with.
   */
  compoundIntervalMs: 3_600_000,
  // Not a cadence. Windows fall due on a multi-day clock the contract publishes, so the
  // keeper waits for the stated moment and this only bounds how long it will sit without
  // asking at all.
  windowIntervalMs: 15 * 60_000,

  /*
   * Zero: harvest whatever is there.
   *
   * The app's browser console has always declined to compound below 1 SCRT of accrued
   * rewards, and the daemon never has. Adopting that floor here as a default would quietly
   * change what an existing keeper does with an existing operator's money, so it is offered
   * rather than imposed.
   */
  compoundFloor: 0,

  /*
   * Paging is a false economy at this size. Four validators cost 66 689 gas in one call and
   * 107 496 in two, because the second transaction pays the base cost again. Paging exists
   * so a huge set cannot exceed the block gas limit; at ~7 000 gas each, fifty validators
   * still fit in one call.
   */
  pageLimit: 25,
  // Sized per transaction from the validator set — see `Keeper.gasLimit`. A flat number is
  // either tight on a large set or wasteful on a small one.
  gasLimit: 0,
  // The chain's minimum is 0.0125 uscrt. Twice that absorbs a min-price change without an
  // emergency redeploy; the old 0.1 was eight times the floor for no reason.
  gasPrice: "0.025uscrt",
};

/**
 * Parse `"30s"`, `"10m"`, `"6h"` into milliseconds.
 *
 * Exported because the console validates what somebody typed before saving it, and it must
 * agree with the process about what a duration is.
 */
export function parseDuration(raw: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`must look like "30s", "10m" or "6h", got "${raw}"`);
  }
  const scales: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
  const scale = scales[match[2] as string];
  if (scale === undefined) {
    throw new Error(`unsupported unit "${match[2]}"`);
  }
  return Number(match[1]) * scale;
}

/** Back into the shape a person typed, for the console and the logs. */
export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

function envDuration(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return parseDuration(raw);
  } catch (e) {
    throw new Error(`${name} ${e instanceof Error ? e.message : String(e)}.`);
  }
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}".`);
  return value;
}

/**
 * Read the three layers and record which one won for each field.
 *
 * The provenance is not decoration. It is what lets the console grey out a field and say
 * *set by the environment* instead of accepting an edit that would go nowhere.
 */
export function resolveSettings(from: Store = store): {
  settings: Settings;
  provenance: Provenance;
} {
  const saved = from.readJson<Partial<Settings>>(FILE, {});

  const env: Partial<Settings> = {
    chainId: process.env.CHAIN_ID || undefined,
    lcdUrl: process.env.LCD_URL || undefined,
    contract: process.env.LST_CORE_ADDRESS || undefined,
    // Distinguished from "unset" by presence, not by emptiness: `LST_CORE_CODE_HASH=` is a
    // deliberate "resolve it from the chain", and treating that as absent would let a saved
    // value override an operator who explicitly cleared it.
    contractCodeHash: process.env.LST_CORE_CODE_HASH,
    compoundIntervalMs: envDuration("COMPOUND_INTERVAL"),
    windowIntervalMs: envDuration("WINDOW_INTERVAL"),
    compoundFloor: envNumber("COMPOUND_FLOOR"),
    pageLimit: envNumber("PAGE_LIMIT"),
    gasLimit: envNumber("GAS_LIMIT"),
    gasPrice: process.env.GAS_PRICE || undefined,
  };

  const settings = { ...DEFAULTS };
  const provenance = {} as Provenance;

  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const fromEnv = env[key];
    const fromFile = saved[key];

    if (fromEnv !== undefined) {
      Object.assign(settings, { [key]: fromEnv });
      provenance[key] = "env";
    } else if (fromFile !== undefined) {
      Object.assign(settings, { [key]: fromFile });
      provenance[key] = "file";
    } else {
      provenance[key] = "default";
    }
  }

  return { settings, provenance };
}

/**
 * Save what the console changed.
 *
 * Only fields the environment has not claimed are written, and only the ones that differ
 * from a default — so `config.json` stays a short list of decisions somebody made rather
 * than a full snapshot that goes stale the moment a default improves.
 */
export function saveSettings(patch: Partial<Settings>, from: Store = store): Settings {
  const { provenance } = resolveSettings(from);
  const saved = from.readJson<Partial<Settings>>(FILE, {});

  for (const [key, value] of Object.entries(patch) as [keyof Settings, unknown][]) {
    if (provenance[key] === "env") continue;
    if (value === undefined) continue;
    if (value === DEFAULTS[key]) delete saved[key];
    else Object.assign(saved, { [key]: value });
  }

  from.writeJson(FILE, saved);
  return resolveSettings(from).settings;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  from: Store = store,
): KeeperConfig {
  const { settings } = resolveSettings(from);

  return {
    ...settings,
    // Late-bound on purpose. The key may not exist when the process starts — the console
    // is partly there so somebody can supply it — and it may be replaced while the process
    // runs, so reading it once at startup would pin whatever was true at boot.
    mnemonic: () => readKey(from),
    once: argv.includes("--once"),
    checkOnly: argv.includes("--check-only"),
  };
}
