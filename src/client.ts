/**
 * Thin wrapper over secret.js for the handful of calls the keeper makes.
 */

import { SecretNetworkClient, Wallet } from "secretjs";

import type { KeeperConfig } from "./config.ts";

export interface ProtocolState {
  total_bonded: string;
  pending_rewards: string;
  liquid_unallocated: string;
  scrt_owed_to_windows: string;
  total_supply: string;
  last_sync_time: number;
  is_unattended: boolean;
  exchange_rate: string;
}

export interface ValidatorEntry {
  address: string;
  weight_bps: number;
  status: "active" | "draining" | "removed";
  bonded: string;
  pending_rewards: string;
  active_unbond_entries: number;
}

export interface UnbondWindow {
  id: number;
  opened_at: number;
  closes_at: number;
  matures_at: number;
  shares_burned: string;
  scrt_owed: string;
  scrt_realised: string | null;
  scrt_claimed: string;
  validators_used: string[];
  state: "open" | "unbonding" | "matured" | "settled";
}

/**
 * The ceiling the contract compiles in, and what to assume before the set is known.
 *
 * These are measured, not guessed — see `gasLimit` below for the readings. They are checked
 * against a live devnet by `scripts/gas-probe.mjs`, which lives in the protocol repository
 * and reads *its own copy* of this file. It cannot see this one. If these numbers change
 * here, the probe will keep validating the old ones and keep reporting success.
 */
const MAX_VALIDATORS = 20;
const COMPOUND_BASE_GAS = 95_000;
const PER_VALIDATOR_GAS = 9_300;
const GAS_MARGIN = 2.5;

export class Keeper {
  /** Queries only. Needs no key, so `--check-only` needs no key either. */
  private readonly reader: SecretNetworkClient;
  private readonly config: KeeperConfig;
  private signer: SecretNetworkClient | null = null;
  private resolvedHash: string | null = null;

  constructor(config: KeeperConfig) {
    this.config = config;
    this.reader = new SecretNetworkClient({
      chainId: config.chainId,
      url: config.lcdUrl,
    });
  }

  /**
   * The signing client, built on first use.
   *
   * Deferred so that reading the protocol never requires a key. The mnemonic is read here
   * and nowhere else, which also means a misconfigured key fails at the moment it would
   * have been used rather than at startup, next to the thing that needed it.
   */
  private get signing(): SecretNetworkClient {
    if (!this.signer) {
      const wallet = new Wallet(this.config.mnemonic());
      this.signer = new SecretNetworkClient({
        chainId: this.config.chainId,
        url: this.config.lcdUrl,
        wallet,
        walletAddress: wallet.address,
      });
    }
    return this.signer;
  }

  /** Whether a key is configured at all, without throwing if one is not. */
  get hasKey(): boolean {
    return Boolean(process.env.KEEPER_MNEMONIC);
  }

  get address(): string {
    return this.signing.address;
  }

  /**
   * The contract's code hash: pinned by configuration, or asked of the chain.
   *
   * Secret encrypts query and execute payloads against the code hash, so a wrong one does
   * not degrade — it stops everything. Migrations change it, and this process runs for
   * weeks at a time, so holding whatever was true at startup is a guarantee of breaking
   * exactly once and silently.
   */
  private async codeHash(): Promise<string> {
    if (this.config.contractCodeHash) return this.config.contractCodeHash;
    if (this.resolvedHash) return this.resolvedHash;

    const { code_hash } = await this.reader.query.compute.codeHashByContractAddress({
      contract_address: this.config.contract,
    });
    // An empty answer means the node does not know this contract — a wrong address, or an
    // LCD serving a different chain. Failing here names the cause; carrying an empty hash
    // forward would surface as an unreadable decryption error three calls later.
    if (!code_hash) {
      throw new Error(
        `${this.config.lcdUrl} has no code hash for ${this.config.contract}. ` +
          "Check LST_CORE_ADDRESS and that LCD_URL serves the right chain.",
      );
    }
    this.resolvedHash = code_hash;
    return code_hash;
  }

  /**
   * Run something that needs the code hash, and survive a migration underneath it.
   *
   * On failure this re-asks the chain, and retries **only if the answer differs** from what
   * was just used. Retrying every failure would double the cost of every genuine error and
   * hide it behind a second identical one; retrying none would leave the keeper holding a
   * dead hash after a migration, failing every task until a human noticed. The difference
   * between the two hashes is the evidence, so it is what the decision is made on.
   */
  private async withCodeHash<T>(run: (hash: string) => Promise<T>): Promise<T> {
    const hash = await this.codeHash();
    try {
      return await run(hash);
    } catch (e) {
      // A pinned hash is a deliberate choice; overriding it here would defeat the point.
      if (this.config.contractCodeHash) throw e;

      this.resolvedHash = null;
      const fresh = await this.codeHash();
      if (fresh === hash) throw e;
      return await run(fresh);
    }
  }

  private async query<T>(query: object): Promise<T> {
    return this.withCodeHash(
      async (code_hash) =>
        (await this.reader.query.compute.queryContract({
          contract_address: this.config.contract,
          code_hash,
          query,
        })) as T,
    );
  }

  async state(): Promise<ProtocolState> {
    const answer = await this.query<{ state: ProtocolState }>({ state: {} });
    return answer.state;
  }

  async validators(): Promise<ValidatorEntry[]> {
    const answer = await this.query<{ validators: { validators: ValidatorEntry[] } }>({
      validators: {},
    });
    // Remembered so the gas limit can be sized from the real set rather than from the
    // contract's ceiling. The invariant sweep reads this at the top of every cycle, so it
    // is current well before any transaction goes out.
    this.validatorCount = answer.validators.validators.length;
    return answer.validators.validators;
  }

  async windows(state?: UnbondWindow["state"]): Promise<UnbondWindow[]> {
    const answer = await this.query<{ windows: { windows: UnbondWindow[] } }>({
      windows: { state: state ?? null, start_after: null, limit: 50 },
    });
    return answer.windows.windows;
  }

  /**
   * Send an upkeep message.
   *
   * Failures are returned rather than thrown. Every task the keeper runs is expected to
   * be a no-op sometimes — a window that has not closed yet, a sweep with nothing to
   * harvest — and a keeper that dies on the first such refusal would stop doing the work
   * it exists for.
   */
  async execute(
    msg: object,
  ): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      // Thrown rather than returned so `withCodeHash` can see a rejected transaction as a
      // failure worth re-checking the hash over. A stale hash surfaces as a failed tx, not
      // as an exception, so returning early here would skip the retry that matters most.
      const txHash = await this.withCodeHash(async (code_hash) => {
        const tx = await this.signing.tx.compute.executeContract(
          {
            sender: this.address,
            contract_address: this.config.contract,
            code_hash,
            msg,
            sent_funds: [],
          },
          {
            gasLimit: this.gasLimit(),
            gasPriceInFeeDenom: Number(this.config.gasPrice.replace(/[^\d.]/g, "")),
          },
        );
        if (tx.code !== 0) throw new Error(tx.rawLog);
        return tx.transactionHash;
      });

      return { ok: true, txHash };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Gas for one upkeep transaction, sized from the validator set.
   *
   * Every task the keeper runs costs a fixed amount plus a per-validator amount, so a flat
   * limit is either too small on a large set or overcharges on a small one — and the fee
   * is the limit, not the gas burned, so overcharging is real money. Measured on a devnet:
   *
   *   sync       45 001 at one validator, 66 241 at four   -> ~7 000 each
   *   compound  104 655 at one validator, 132 586 at four  -> ~9 300 each
   *
   * Compound is the expensive shape, so its numbers size every task. A flat 400 000 held
   * at four validators and would have gone tight at the contract's ceiling of twenty.
   *
   * `GAS_LIMIT` still overrides, for a chain whose costs have moved.
   */
  private gasLimit(): number {
    if (this.config.gasLimit) return this.config.gasLimit;
    const n = this.validatorCount ?? MAX_VALIDATORS;
    return Math.ceil((COMPOUND_BASE_GAS + PER_VALIDATOR_GAS * n) * GAS_MARGIN);
  }

  /** Set once the keeper has seen the set, so the first transaction assumes the worst. */
  validatorCount: number | null = null;

  /** Balance of the keeper's own account, so it can warn before it runs out of gas. */
  async gasBalance(): Promise<bigint> {
    const { balance } = await this.reader.query.bank.balance({
      address: this.address,
      denom: "uscrt",
    });
    return BigInt(balance?.amount ?? "0");
  }
}
