/**
 * The console, and the API behind it.
 *
 * `node:http` and a switch statement. No framework, no router package, no template engine —
 * the keeper has one dependency and a settings screen is not a reason for a second. What is
 * here is roughly two hundred lines of routing that anybody can read in one sitting, which
 * matters more than usual for a server that sits next to a signing key.
 *
 * ## What this gave up
 *
 * The keeper used to listen on nothing. That was a real security property and it is spent
 * here, knowingly, to buy three things it could not otherwise have: the cadence reachable
 * without editing a file next to a mnemonic, a record of what was sent, and an install that
 * does not require SSH. What is kept in exchange:
 *
 * - a password before anything but `/healthz` answers, set on first run, no default
 * - the key is write-only through this interface; no route returns it
 * - a content security policy with no remote origins at all, so the page cannot be made to
 *   send anything anywhere even if something got into it
 * - `/healthz` reports the last completed pass rather than running a new one, so an
 *   unauthenticated probe cannot be turned into a way to make this process query a chain
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cookieHeader,
  endSession,
  isConfigured,
  sessionFrom,
  setPassword,
  startSession,
  validSession,
  verify,
} from "./auth.ts";
import {
  DEFAULTS,
  formatDuration,
  parseDuration,
  resolveSettings,
  saveSettings,
  type Settings,
} from "./config.ts";
import { feeFor } from "./history.ts";
import { isTaskName, log, TASKS, type Runtime } from "./runtime.ts";
import * as secrets from "./secrets.ts";
import { DATA_DIR, store } from "./store.ts";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

const PORT = Number(process.env.KEEPER_PORT ?? 8787);
/**
 * All interfaces by default.
 *
 * Inside a container there is no other useful choice — binding to loopback would make the
 * published port answer nothing, which looks exactly like a crashed process. `KEEPER_BIND`
 * exists for running it directly on a machine where loopback is what you want.
 */
const BIND = process.env.KEEPER_BIND ?? "0.0.0.0";

/** Anything larger is not a settings form. */
const MAX_BODY = 64 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * No remote origin appears anywhere.
 *
 * Everything the page needs — styles, script, fonts, both marks — is served from here, so
 * the policy can be closed completely rather than opened for a font CDN. On a page that can
 * be made to set a signing key, `connect-src 'self'` is the line that matters: there is no
 * origin it is permitted to talk to except the process that served it.
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("That was not valid JSON.");
  }
}

function text(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Validate a settings patch before any of it is written.
 *
 * All-or-nothing: a form that saved four good fields and rejected the fifth would leave the
 * operator guessing which four landed. Durations are accepted as the strings a person types
 * (`"6h"`) and stored as milliseconds, so the console and the environment agree about what
 * a cadence is.
 */
function patchFrom(body: Record<string, unknown>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  const fail = (field: string, why: string) => {
    throw new Error(`${field}: ${why}`);
  };

  for (const key of ["chainId", "contract", "contractCodeHash", "gasPrice"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string") fail(key, "must be text");
    patch[key] = (value as string).trim();
  }

  if (body.lcdUrl !== undefined) {
    const url = normaliseUrl(String(body.lcdUrl));
    if (!url) fail("lcdUrl", "must be an http or https address");
    patch.lcdUrl = url as string;
  }

  for (const [key, field] of [
    ["compoundIntervalMs", "compoundInterval"],
    ["windowIntervalMs", "windowInterval"],
  ] as const) {
    const value = body[field];
    if (value === undefined) continue;
    try {
      patch[key] = parseDuration(String(value));
    } catch (e) {
      fail(field, e instanceof Error ? e.message : String(e));
    }
  }

  for (const key of ["compoundFloor", "pageLimit", "gasLimit"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) fail(key, "must be zero or more");
    patch[key] = parsed;
  }

  if (patch.pageLimit !== undefined && patch.pageLimit < 1) {
    fail("pageLimit", "must be at least 1 — zero would page forever");
  }

  return patch;
}

export function normaliseUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Ask a node what it is, and how quickly it answers.
 *
 * Ported from the app's endpoint picker, including the part that earns its keep: a node
 * serving a different chain is reported as a *failure* rather than as a healthy endpoint.
 * Pointing the keeper at a fast node for the wrong network is the mistake that produces
 * unreadable decryption errors three calls later.
 */
export async function checkEndpoint(
  url: string,
  expectChain: string,
  timeoutMs = 6_000,
): Promise<{
  url: string;
  ok: boolean;
  latencyMs: number | null;
  chainId: string | null;
  height: number | null;
  error: string | null;
}> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { url, ok: false, latencyMs, chainId: null, height: null, error: `HTTP ${res.status}` };
    }

    const body = (await res.json()) as { block?: { header?: { chain_id?: string; height?: string } } };
    const chainId = body.block?.header?.chain_id ?? null;
    const height = Number(body.block?.header?.height) || null;

    if (chainId && chainId !== expectChain) {
      return { url, ok: false, latencyMs, chainId, height, error: `serves ${chainId}, not ${expectChain}` };
    }
    return { url, ok: true, latencyMs, chainId, height, error: null };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      url,
      ok: false,
      latencyMs: null,
      chainId: null,
      height: null,
      error: aborted ? `no answer in ${timeoutMs / 1000}s` : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // `normalize` then reject anything that climbed out. The alternative — trusting the URL
  // parser — is how a static handler becomes an arbitrary file read.
  const safe = normalize(relative);
  if (safe.startsWith("..") || safe.includes(`..${"/"}`) || safe.includes(`..\\`)) return false;

  try {
    const body = await readFile(join(WEB_ROOT, safe));
    const type = TYPES[extname(safe).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // The assets are versioned by the image tag, and the page must never be stale after
      // an upgrade, so only the fonts and marks are worth caching.
      "cache-control": /\.(woff2|png|svg)$/.test(safe) ? "public, max-age=604800" : "no-store",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function serve(runtime: Runtime) {
  let running = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const token = sessionFrom(req.headers.cookie);
    const authed = validSession(token);

    try {
      /*
       * The health probe, unauthenticated and read-only.
       *
       * It reports the last completed pass rather than running one. The loop passes every
       * sixty seconds, so the answer is never more than that stale — and this way a probe
       * cannot be used to make the keeper query a chain on somebody else's schedule.
       */
      if (path === "/healthz") {
        const alerts = runtime.findings.filter((f) => f.severity === "alert");
        const started = runtime.lastPassAt === null;
        return send(
          res,
          started ? 503 : alerts.length > 0 ? 503 : 200,
          {
            status: started ? "starting" : alerts.length > 0 ? "unhealthy" : "healthy",
            lastPassAt: runtime.lastPassAt,
            alerts: alerts.map((f) => ({ check: f.check, detail: f.detail })),
          },
        );
      }

      // Whether anyone has set a password yet. The one thing the console may ask before it
      // has a session, because it decides which screen to draw.
      if (path === "/api/session" && method === "GET") {
        return send(res, 200, { configured: isConfigured(), authenticated: authed });
      }

      if (path === "/api/setup" && method === "POST") {
        if (isConfigured()) return send(res, 409, { error: "A password is already set." });
        const body = await readBody(req);
        const password = text(body, "password");
        if (!password) return send(res, 400, { error: "A password is required." });

        setPassword(password);
        const fresh = startSession();
        log("info", "console password set");
        return send(res, 200, { ok: true }, { "set-cookie": cookieHeader(fresh) });
      }

      if (path === "/api/login" && method === "POST") {
        const body = await readBody(req);
        const password = text(body, "password");
        if (!password || !verify(password)) {
          // Deliberately one message for both "no password set" and "wrong password".
          return send(res, 401, { error: "That password is not right." });
        }
        return send(res, 200, { ok: true }, { "set-cookie": cookieHeader(startSession()) });
      }

      if (path === "/api/logout" && method === "POST") {
        endSession(token);
        return send(res, 200, { ok: true }, { "set-cookie": cookieHeader(null) });
      }

      if (path.startsWith("/api/")) {
        if (!authed) return send(res, 401, { error: "Not signed in." });
        return await api(req, res, path, method, runtime, {
          get running() {
            return running;
          },
          set running(value: boolean) {
            running = value;
          },
        });
      }

      if (method === "GET" && (await serveStatic(res, path))) return;

      // Anything unmatched falls back to the page. There is one route in this console and a
      // deep link somebody bookmarked should open it, not a 404.
      if (method === "GET" && (await serveStatic(res, "/"))) return;

      return send(res, 404, { error: "No such route." });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log("warn", "request failed", { path, detail });
      return send(res, 400, { error: detail });
    }
  });

  server.listen(PORT, BIND, () => {
    log("info", "console listening", { url: `http://${BIND}:${PORT}`, data: DATA_DIR });
  });

  return server;
}

async function api(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  runtime: Runtime,
  lock: { running: boolean },
) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (path === "/api/status" && method === "GET") {
    const key = secrets.status();
    const next = runtime.nextDue();
    return send(res, 200, {
      address: runtime.keeper.maybeAddress,
      key,
      chainId: runtime.config.chainId,
      contract: runtime.config.contract,
      lcdUrl: runtime.config.lcdUrl,
      gasPrice: runtime.config.gasPrice,
      compoundIntervalMs: runtime.config.compoundIntervalMs,
      // What the console needs to price a cadence. Computed here from the same function
      // that sizes the real transaction, so the figure on the screen and the figure on the
      // invoice cannot drift apart.
      validators: runtime.keeper.validatorCount,
      compoundFeeUscrt: feeFor(runtime.keeper.gasLimit(), runtime.config.gasPrice),
      startedAt: runtime.startedAt,
      lastPassAt: runtime.lastPassAt,
      lastError: runtime.lastError,
      writable: store.writable,
      findings: runtime.findings,
      tasks: TASKS.map((task) => {
        const outcome = runtime.outcomes.get(task);
        return {
          task,
          detail: outcome?.detail ?? null,
          did: outcome?.did ?? null,
          error: outcome?.error ?? null,
          /*
           * `sync` has no schedule and must not appear to have one.
           *
           * It survives only as a fallback for a compound that failed while the figures were
           * stale, so quoting the compound schedule beside it would advertise a run that is
           * never going to happen on its own. The console reads a null as "on demand".
           */
          nextDue:
            task === "sync" ? null : task === "compound" ? next.compound : next.window,
        };
      }),
      summary: runtime.history.summary(),
    });
  }

  if (path === "/api/settings" && method === "GET") {
    const { settings, provenance } = resolveSettings();
    return send(res, 200, {
      settings: {
        ...settings,
        compoundInterval: formatDuration(settings.compoundIntervalMs),
        windowInterval: formatDuration(settings.windowIntervalMs),
      },
      provenance,
      defaults: DEFAULTS,
      writable: store.writable,
    });
  }

  if (path === "/api/settings" && method === "POST") {
    if (!store.writable) {
      return send(res, 409, {
        error: "The data directory is not writable, so nothing can be saved. Is a volume mounted?",
      });
    }
    const patch = patchFrom(await readBody(req));
    saveSettings(patch);
    const config = runtime.reconfigure();
    runtime.note("config", `settings changed: ${Object.keys(patch).join(", ") || "nothing"}`);
    return send(res, 200, {
      ok: true,
      compoundInterval: formatDuration(config.compoundIntervalMs),
      windowInterval: formatDuration(config.windowIntervalMs),
    });
  }

  if (path === "/api/wallet" && method === "GET") {
    return send(res, 200, { ...secrets.status(), address: runtime.keeper.maybeAddress });
  }

  if (path === "/api/wallet" && method === "POST") {
    if (!store.writable) {
      return send(res, 409, {
        error: "The data directory is not writable, so a key cannot be stored. Is a volume mounted?",
      });
    }
    if (!secrets.status().editable) {
      return send(res, 409, {
        error: "KEEPER_MNEMONIC is set in the environment and takes precedence. Remove it first.",
      });
    }

    const body = await readBody(req);
    const mnemonic = text(body, "mnemonic");
    if (!mnemonic) return send(res, 400, { error: "A recovery phrase is required." });

    secrets.setKey(mnemonic, { passphrase: text(body, "passphrase") });
    // Rebuild the client: it caches its signing wallet on first use, so a new key that
    // arrives after a transaction has gone out would otherwise never be picked up.
    runtime.reconfigure();

    const address = runtime.keeper.maybeAddress;
    runtime.note("wallet", `key set, signing as ${address ?? "an address that could not be derived"}`);
    return send(res, 200, { ...secrets.status(), address });
  }

  if (path === "/api/wallet/unlock" && method === "POST") {
    const passphrase = text(await readBody(req), "passphrase");
    if (!passphrase) return send(res, 400, { error: "A passphrase is required." });
    if (!secrets.unlock(passphrase)) {
      return send(res, 401, { error: "That passphrase does not decrypt the stored key." });
    }
    runtime.reconfigure();
    return send(res, 200, { ...secrets.status(), address: runtime.keeper.maybeAddress });
  }

  if (path === "/api/wallet" && method === "DELETE") {
    secrets.forgetKey();
    runtime.reconfigure();
    runtime.note("wallet", "key removed — the keeper is reading but not signing");
    return send(res, 200, { ...secrets.status(), address: null });
  }

  if (path === "/api/password" && method === "POST") {
    const body = await readBody(req);
    const current = text(body, "current");
    const next = text(body, "password");
    if (!current || !verify(current)) return send(res, 401, { error: "The current password is not right." });
    if (!next) return send(res, 400, { error: "A new password is required." });

    setPassword(next);
    return send(res, 200, { ok: true }, { "set-cookie": cookieHeader(startSession()) });
  }

  if (path === "/api/history" && method === "GET") {
    const outcome = url.searchParams.get("outcome");
    return send(res, 200, {
      ...runtime.history.page({
        task: url.searchParams.get("task") ?? undefined,
        outcome: outcome === "ok" || outcome === "failed" ? outcome : undefined,
        limit: Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200),
        offset: Number(url.searchParams.get("offset") ?? 0) || 0,
      }),
      summary: runtime.history.summary(),
      gasPrice: runtime.config.gasPrice,
      chainId: runtime.config.chainId,
    });
  }

  if (path === "/api/run" && method === "POST") {
    if (!secrets.hasKey()) {
      return send(res, 409, { error: "No key is configured, so nothing can be sent." });
    }
    /*
     * One at a time.
     *
     * Not for safety — every task is idempotent and the contract refuses what is not due,
     * which is why two keepers running at once is harmless — but a double-clicked button
     * should not spend gas twice to be told twice that there was nothing to do.
     */
    if (lock.running) return send(res, 409, { error: "A task is already running." });

    const name = text(await readBody(req), "task");
    if (!name || !isTaskName(name)) {
      return send(res, 400, { error: `Unknown task. One of: ${TASKS.join(", ")}.` });
    }

    lock.running = true;
    try {
      const outcome = await runtime.runTask(name);
      return send(res, 200, {
        task: outcome.task,
        did: outcome.did,
        detail: outcome.detail,
        error: outcome.error ?? null,
        txs: (outcome.receipts ?? []).map((r) => r.txHash),
      });
    } finally {
      lock.running = false;
    }
  }

  if (path === "/api/endpoint/check" && method === "POST") {
    const body = await readBody(req);
    const raw = text(body, "url");
    const candidate = raw ? normaliseUrl(raw) : null;
    if (!candidate) return send(res, 400, { error: "That is not an http or https address." });
    return send(
      res,
      200,
      await checkEndpoint(candidate, text(body, "chainId") ?? runtime.config.chainId),
    );
  }

  return send(res, 404, { error: "No such route." });
}
