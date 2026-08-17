/**
 * Do the interfaces in `src/client.ts` still describe what the contract actually returns?
 *
 * The contract's types live in a different repository, in Rust, and these are hand-written
 * mirrors of them. Nothing compiles the two together, so a renamed field is not a build
 * error anywhere — it is a `undefined` at runtime, in a keeper that has been running for
 * three weeks, at whatever hour the migration landed.
 *
 * This is the only thing in this repository that would notice. It asks the live chain and
 * compares key sets **in both directions**: a field the contract dropped, and a field the
 * contract added that these types do not know about. The second direction matters more than
 * it looks — a new field is how you find out the protocol grew a concept you have not
 * modelled yet.
 *
 * Values are deliberately not asserted. This runs against a live chain whose numbers change
 * every block, and a test that flakes gets muted, and a muted test is worse than none.
 *
 * Run separately from the build checks, on a schedule — a testnet outage is not a reason to
 * block a merge.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Keeper, type ProtocolState, type UnbondWindow, type ValidatorEntry } from "../src/client.ts";
import { loadConfig } from "../src/config.ts";

/*
 * TypeScript types are erased at runtime, so the key list has to exist as data. `satisfies`
 * is what keeps the two honest: the compiler rejects this array if it names a key the
 * interface does not have, so it cannot rot into a list of fields nobody declares.
 *
 * It does not catch the reverse — a key added to the interface and forgotten here — which
 * is why the contract-side direction of the comparison is the one doing the real work.
 */
const STATE_KEYS = [
  "total_bonded",
  "pending_rewards",
  "liquid_unallocated",
  "scrt_owed_to_windows",
  "total_supply",
  "last_sync_time",
  "is_unattended",
  "exchange_rate",
] as const satisfies readonly (keyof ProtocolState)[];

const VALIDATOR_KEYS = [
  "address",
  "weight_bps",
  "status",
  "bonded",
  "pending_rewards",
  "active_unbond_entries",
] as const satisfies readonly (keyof ValidatorEntry)[];

const WINDOW_KEYS = [
  "id",
  "opened_at",
  "closes_at",
  "matures_at",
  "shares_burned",
  "scrt_owed",
  "scrt_realised",
  "scrt_claimed",
  "validators_used",
  "state",
] as const satisfies readonly (keyof UnbondWindow)[];

function compare(what: string, declared: readonly string[], actual: object) {
  const got = Object.keys(actual);

  const missing = declared.filter((k) => !got.includes(k));
  const unknown = got.filter((k) => !declared.includes(k));

  assert.deepEqual(
    missing,
    [],
    `${what}: the contract no longer returns ${missing.join(", ")} — src/client.ts is describing a protocol that has moved on`,
  );
  assert.deepEqual(
    unknown,
    [],
    `${what}: the contract returned ${unknown.join(", ")}, which src/client.ts does not model — the protocol grew something this keeper cannot see`,
  );
}

// No key needed: every query here is public, and requiring a mnemonic to read public state
// is what made this test impossible to run in CI before.
const keeper = new Keeper(loadConfig([]));

test("State matches ProtocolState", async () => {
  compare("State", STATE_KEYS, await keeper.state());
});

test("Validators match ValidatorEntry", async () => {
  const validators = await keeper.validators();
  assert.ok(validators.length > 0, "the protocol reported no validators at all");
  for (const v of validators) compare(`Validator ${v.address}`, VALIDATOR_KEYS, v);
});

test("Windows match UnbondWindow", async () => {
  const windows = await keeper.windows();
  assert.ok(windows.length > 0, "the protocol reported no windows — one is open from birth");
  for (const w of windows) compare(`Window ${w.id}`, WINDOW_KEYS, w);
});

/*
 * The resolver is the thing that lets this keeper sit through a migration, so prove it
 * works rather than trusting that it does. If this fails, every other test here failed too
 * and this one says why.
 */
test("the code hash resolves from the chain", async () => {
  const state = await keeper.state();
  assert.ok(state.exchange_rate.length > 0, "resolved a code hash but got nothing back");
});
