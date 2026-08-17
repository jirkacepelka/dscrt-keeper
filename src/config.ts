/**
 * Keeper configuration, read from the environment.
 *
 * The keeper is deliberately unprivileged. Every task it performs is a permissionless
 * message that anyone could send, so its key needs gas and nothing else: losing it costs
 * the operator some SCRT and stalls upkeep until a replacement runs, but it cannot move
 * user funds, change the fee, or touch the validator set. Nothing here should ever be
 * given the manager's key.
 */

export interface KeeperConfig {
  chainId: string;
  lcdUrl: string;
  /**
   * Read on demand, not at startup.
   *
   * `--check-only` sends nothing — it reads the protocol and reports whether the figures
   * hold — so demanding a signing key before it will run was asking for a credential to
   * perform a query. It also made the health probe impossible to run anywhere that has no
   * business holding one, which is most places worth running it from.
   */
  mnemonic: () => string;
  contract: string;
  /**
   * Pinned by `LST_CORE_CODE_HASH`, or resolved from the chain when that is unset.
   *
   * Empty means "resolve it" — see `Keeper.codeHash`. A migration changes this value, and
   * a keeper that runs for weeks will sit through one.
   */
  contractCodeHash: string;

  /** How often to harvest and restake rewards. Also what keeps the cached totals current. */
  compoundIntervalMs: number;
  /**
   * The longest the keeper will go without asking whether a window is due.
   *
   * A ceiling, not a cadence: when the chain reports a deadline the keeper wakes for it
   * exactly, and this only bounds the case where nothing is pending at all.
   */
  windowIntervalMs: number;

  /** Validators handled per paginated call. */
  pageLimit: number;
  /** Gas limit per upkeep transaction. */
  gasLimit: number;
  gasPrice: string;

  /** Exit after a single pass instead of looping. Useful under an external scheduler. */
  once: boolean;
  /** Run the invariant checks and report, without sending anything. */
  checkOnly: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See .env.example.`);
  }
  return value;
}

function duration(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;

  const match = /^(\d+)(s|m|h)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must look like "30s", "10m" or "6h", got "${raw}".`);
  }

  const scales: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
  const scale = scales[match[2] as string];
  if (scale === undefined) {
    throw new Error(`${name} has an unsupported unit "${match[2]}".`);
  }
  return Number(match[1]) * scale;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): KeeperConfig {
  return {
    /*
     * Defaults are the live dSCRT deployment, so running this against the protocol it was
     * written for takes a mnemonic and nothing else.
     *
     * They previously named `secret-4` and a mainnet node. There is no mainnet deployment,
     * so those defaults pointed at a contract that does not exist — a default that cannot
     * work is worse than no default, because it fails somewhere further from the cause.
     */
    chainId: process.env.CHAIN_ID ?? "pulsar-3",
    lcdUrl: process.env.LCD_URL ?? "https://pulsar.lcd.secretnodes.com",
    mnemonic: () => required("KEEPER_MNEMONIC"),
    contract: process.env.LST_CORE_ADDRESS ?? "secret1lj23n74aan7nlgj6hfm45fh3gc7h2ctdplsw8y",
    // Optional. Unset means the keeper asks the chain, which is what lets it sit through a
    // migration without anybody editing a file.
    contractCodeHash: process.env.LST_CORE_CODE_HASH ?? "",

    /*
     * Hourly, and it is the only thing on a clock.
     *
     * `Compound` re-reads every validator from the staking module and restamps
     * `last_sync_time` whether or not it found anything to harvest, so it does everything
     * `Sync` did and harvests as well. Running both was paying twice for one of them: at
     * the old cadence that was 4 compounds and 48 syncs a day, where 24 compounds cover
     * the same ground for fewer transactions.
     *
     * Hourly is not about yield. Rewards accrue continuously and harvesting only moves
     * them, so compounding 24 times a day rather than 4 is worth a rounding error on the
     * APY. What it buys is a published exchange rate that is never more than an hour
     * behind the chain, for a gas bill that is now small enough not to argue with.
     */
    compoundIntervalMs: duration("COMPOUND_INTERVAL", 3_600_000),
    // Not a cadence — see `windowIntervalMs`. Windows fall due on a multi-day clock the
    // contract publishes, so the keeper waits for the stated moment and this only bounds
    // how long it will sit without asking at all.
    windowIntervalMs: duration("WINDOW_INTERVAL", 15 * 60_000),

    /*
     * Sized from measurement, not from caution. Against a four-validator devnet:
     *
     *   sync,  1 validator    44 910 gas
     *   sync,  4 validators   66 689 gas
     *   compound, 4           99 601 gas
     *
     * so a validator costs roughly 7 000 gas and the fixed cost of being a transaction
     * at all is around 38 000. Two consequences, both of which the old defaults got
     * backwards.
     *
     * Paging is a false economy at this size. The same four validators cost 66 689 gas in
     * one call and 107 496 in two, because the second transaction pays the base cost
     * again. Paging exists so a huge set cannot exceed the block gas limit; at 7 000 gas
     * each, fifty validators still fit in one call, so the page should cover the whole
     * allowlist and only shrink if a set ever grows past that.
     *
     * The gas limit is charged in full. Cosmos takes the fee you declare, not the gas you
     * burn, so declaring 1 500 000 for a 67 000-gas transaction was paying 22x over the
     * odds on every single one. It is now sized per transaction from the validator set —
     * see `Keeper.gasLimit` — because a flat number is either tight on a large set or
     * wasteful on a small one. Setting GAS_LIMIT overrides that, for a chain whose costs
     * have moved.
     */
    pageLimit: Number(process.env.PAGE_LIMIT ?? 25),
    gasLimit: process.env.GAS_LIMIT ? Number(process.env.GAS_LIMIT) : 0,
    // The chain's minimum is 0.0125 uscrt. Twice that absorbs a min-price change without
    // an emergency redeploy; the old 0.1 was eight times the floor for no reason.
    gasPrice: process.env.GAS_PRICE ?? "0.025uscrt",

    once: argv.includes("--once"),
    checkOnly: argv.includes("--check-only"),
  };
}
