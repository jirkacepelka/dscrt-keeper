#!/usr/bin/env node
/**
 * Upkeep for the SCRT liquid staking protocol.
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
 *
 * This file is only the entry point. The work is in `runtime.ts`, and the console that
 * drives it is in `server.ts`.
 */

import { formatDuration, loadConfig } from "./config.ts";
import { log, Runtime } from "./runtime.ts";
import { hasKey } from "./secrets.ts";
import { serve } from "./server.ts";
import { DATA_DIR, store } from "./store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = loadConfig();
  const runtime = new Runtime(config);

  log("info", "keeper starting", {
    // A keyless run is legitimate — `--check-only` sends nothing — so this reports the
    // absence rather than demanding a mnemonic in order to print a line.
    address: hasKey() ? runtime.keeper.address : "(no key — read only)",
    contract: config.contract,
    chain: config.chainId,
    mode: config.checkOnly ? "check-only" : config.once ? "single pass" : "loop",
  });

  /*
   * One pass and out.
   *
   * Returns before anything is started or written: this is the health probe and the manual
   * unstick, and neither has any business opening a port or creating a data directory.
   */
  if (config.once || config.checkOnly) {
    if (config.once && !hasKey()) {
      throw new Error("No key configured. Set KEEPER_MNEMONIC, or set one in the console.");
    }
    const verdict = await runtime.pass();
    if (verdict === "unhealthy") process.exitCode = 1;
    return;
  }

  /*
   * The console comes up first, and comes up without a key.
   *
   * The keeper used to refuse to start at all without a mnemonic, which is the right
   * behaviour for a process whose only job is to send transactions and the wrong one for a
   * process that now exists partly so somebody can *supply* that mnemonic. A keeper with no
   * key reads the protocol, reports it, and says on screen that it cannot sign — which is
   * strictly more useful than exiting with an error nobody is watching for.
   */
  serve(runtime);

  if (!hasKey()) {
    log("warn", "no key configured", {
      detail: "reading the protocol but not signing. Set a mnemonic in the console.",
    });
  }

  log("info", "data directory", {
    path: DATA_DIR,
    writable: store.writable,
  });

  runtime.note(
    "start",
    `keeper up, compounding every ${formatDuration(config.compoundIntervalMs)}`,
  );

  // The loop never exits on error. A keeper that dies on a transient RPC failure is worse
  // than one that logs it and tries again in a minute, because the failure it is meant to
  // prevent is precisely "nobody ran the upkeep".
  for (;;) {
    try {
      await runtime.pass();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      runtime.lastError = detail;
      log("error", "pass failed", { detail });
    }
    await sleep(60_000);
  }
}

main().catch((e) => {
  log("error", "fatal", { detail: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
