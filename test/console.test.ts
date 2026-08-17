/**
 * The console's API, driven end to end.
 *
 * A real keeper process against a real HTTP port and a real data directory, because the
 * things most likely to break here are exactly the things a unit test would have mocked:
 * that the password gate actually refuses, that a stored key never comes back out, that a
 * cadence change reaches the running schedule, and that the environment beats the file
 * rather than the other way round.
 *
 * It uses a throwaway data directory and never touches the chain: the server comes up
 * before the first upkeep pass, so every route below answers whether or not an LCD is
 * reachable. That is deliberate — a console test that fails because a testnet is having a
 * bad afternoon is a test that gets muted.
 *
 * Run with `npm run test:console`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * A published BIP-39 test vector, not anybody's key.
 *
 * The all-`abandon` phrase appears in the BIP-39 specification itself and in the test suite
 * of every wallet that implements it. Nothing is ever sent to the address it derives, and
 * the file it lands in is deleted when this test finishes.
 */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const PASSWORD = "correct-horse-battery";

let keeper: ChildProcess;
let dataDir: string;
let cookie = "";

/** Fetch that carries the session cookie the way a browser would. */
async function call(path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0] ?? "";

  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const send = (path: string, body: unknown, method = "POST") =>
  call(path, { method, body: JSON.stringify(body) });

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "dscrt-keeper-test-"));

  keeper = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      KEEPER_DATA_DIR: dataDir,
      KEEPER_PORT: String(PORT),
      KEEPER_BIND: "127.0.0.1",
      // Cleared, so the console owns the key. Inherited from a developer's shell it would
      // pin the field and make half of this file test the wrong branch.
      KEEPER_MNEMONIC: "",
      // Set, so the environment-beats-file rule has something to prove itself against.
      GAS_PRICE: "0.0301uscrt",
    },
    stdio: "ignore",
  });

  // Poll rather than sleep: the process reaches the chain on its first pass and how long
  // that takes is not this test's business.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/healthz`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("the keeper never opened its port");
});

after(() => {
  keeper?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the health probe answers without a session", async () => {
  const { status, body } = await call("/healthz");
  // 503 while the first pass is still in flight is correct, not a failure.
  assert.ok(status === 200 || status === 503, `unexpected ${status}`);
  assert.ok(["healthy", "unhealthy", "starting"].includes(body.status));
});

test("everything else refuses before a password is set", async () => {
  for (const path of ["/api/status", "/api/settings", "/api/history", "/api/wallet"]) {
    assert.equal((await call(path)).status, 401, `${path} answered without a session`);
  }
});

test("the first run reports itself as unconfigured", async () => {
  const { body } = await call("/api/session");
  assert.equal(body.configured, false);
  assert.equal(body.authenticated, false);
});

test("a short password is refused", async () => {
  const { status } = await send("/api/setup", { password: "short" });
  assert.equal(status, 400);
});

test("setup sets the password and signs in", async () => {
  const { status } = await send("/api/setup", { password: PASSWORD });
  assert.equal(status, 200);
  assert.ok(cookie.startsWith("dscrt_keeper_session="), "no session cookie came back");

  const session = await call("/api/session");
  assert.equal(session.body.configured, true);
  assert.equal(session.body.authenticated, true);
});

test("setup cannot be run twice", async () => {
  assert.equal((await send("/api/setup", { password: "another-one-entirely" })).status, 409);
});

test("the environment beats the saved file", async () => {
  const { body } = await call("/api/settings");
  assert.equal(body.provenance.gasPrice, "env", "GAS_PRICE was set but did not win");
  assert.equal(body.settings.gasPrice, "0.0301uscrt");

  // Saving it anyway must be ignored rather than written, or the console would be showing
  // a value the process does not use.
  await send("/api/settings", { gasPrice: "0.999uscrt" });
  assert.equal((await call("/api/settings")).body.settings.gasPrice, "0.0301uscrt");
});

test("a cadence change is applied and persisted", async () => {
  const { status, body } = await send("/api/settings", { compoundInterval: "6h" });
  assert.equal(status, 200);
  assert.equal(body.compoundInterval, "6h");

  assert.equal((await call("/api/settings")).body.settings.compoundInterval, "6h");
  assert.equal(
    JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).compoundIntervalMs,
    21_600_000,
  );
});

test("a nonsense duration is refused with a sentence", async () => {
  const { status, body } = await send("/api/settings", { compoundInterval: "sometimes" });
  assert.equal(status, 400);
  assert.match(body.error, /compoundInterval/);
});

test("an endpoint on another chain is reported as unusable", async () => {
  const { body } = await send("/api/endpoint/check", {
    url: "https://lcd.mainnet.secretsaturn.net",
    chainId: "pulsar-3",
  });
  // Either it answered and serves secret-4, or it was unreachable. Both are "not ok" — what
  // must never happen is a node on the wrong chain being reported as fine.
  assert.equal(body.ok, false);
});

test("a key can be set, and never comes back out", async () => {
  const { status, body } = await send("/api/wallet", { mnemonic: TEST_MNEMONIC });
  assert.equal(status, 200);
  assert.ok(body.address?.startsWith("secret1"), "no address was derived");
  assert.equal(body.configured, true);
  assert.equal(body.source, "file");

  const read = await call("/api/wallet");
  assert.equal(read.body.configured, true);
  assert.equal(read.body.address, body.address);
  assert.equal(
    JSON.stringify(read.body).includes("abandon"),
    false,
    "the wallet route returned the phrase it was given",
  );

  const status2 = await call("/api/status");
  assert.equal(
    JSON.stringify(status2.body).includes("abandon"),
    false,
    "the status route leaked the phrase",
  );
});

test("a phrase of the wrong length is refused before it reaches a wallet", async () => {
  const { status, body } = await send("/api/wallet", { mnemonic: "one two three" });
  assert.equal(status, 400);
  assert.match(body.error, /12 or 24 words/);
});

test("an encrypted key round-trips through its passphrase", async () => {
  const set = await send("/api/wallet", {
    mnemonic: TEST_MNEMONIC,
    passphrase: "a-passphrase-for-the-file",
  });
  assert.equal(set.body.source, "encrypted");
  assert.equal(set.body.locked, false, "the key it just wrote should already be open");

  // On disk it must be an envelope, not a phrase.
  const onDisk = readFileSync(join(dataDir, "wallet.enc"), "utf8");
  assert.equal(onDisk.includes("abandon"), false, "the phrase was written in the clear");
  assert.match(onDisk, /"v": 1/);

  const wrong = await send("/api/wallet/unlock", { passphrase: "not-the-passphrase" });
  assert.equal(wrong.status, 401);
});

test("the ledger records what the operator did", async () => {
  const { body } = await call("/api/history");
  const tasks = body.entries.map((e: { task: string }) => e.task);
  assert.ok(tasks.includes("wallet"), "setting a key was not recorded");
  assert.ok(tasks.includes("config"), "changing a setting was not recorded");
  assert.ok(tasks.includes("start"), "the keeper starting was not recorded");
});

test("signing out actually ends the session", async () => {
  await send("/api/logout", {});
  assert.equal((await call("/api/status")).status, 401);

  assert.equal((await send("/api/login", { password: "the-wrong-one" })).status, 401);
  assert.equal((await send("/api/login", { password: PASSWORD })).status, 200);
  assert.equal((await call("/api/status")).status, 200);
});

test("the console itself is served, with a closed policy", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);

  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.equal(csp.includes("unsafe-inline"), false, "the policy allows inline");
  assert.match(csp, /connect-src 'self'/);

  const html = await res.text();
  assert.equal(
    /\sstyle="/.test(html),
    false,
    "the page carries a style attribute, which that policy blocks",
  );
});

test("the static handler cannot be walked out of", async () => {
  /*
   * The manifest is the file directly above the web root, so it is the one an escape would
   * reach first. Matched on `"dependencies"` rather than on the package name, which also
   * appears in the console's own footer link — the first version of this test asserted on
   * the name and failed against a page that had not escaped anything.
   */
  for (const path of ["/../package.json", "/..%2Fpackage.json", "/fonts/../../package.json"]) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text();
    assert.equal(body.includes(`"dependencies"`), false, `${path} escaped the web root`);
    assert.equal(body.includes("KEEPER_MNEMONIC"), false, `${path} reached the data directory`);
  }
});
