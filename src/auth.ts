/**
 * Who may touch the console.
 *
 * The keeper now listens on a port and holds a signing key. Those two facts together are
 * the whole argument for this file: without it, anything on the home network — a guest's
 * laptop, a compromised smart plug, another container on the same ZimaOS box — could read
 * the configuration, change where the keeper points, and replace the key.
 *
 * It is a password and a session cookie, and nothing more ambitious. No user accounts, no
 * roles, no password reset by email. There is one operator, they are standing in front of
 * the machine, and the recovery path when they forget the password is to delete
 * `admin.json` from the data directory — which is a thing only somebody with the box can
 * do, which is the right bar.
 *
 * ## First run
 *
 * There is no default password. A shipped default is a published default, and this guards a
 * key. The console's first screen sets one, and until it is set every route except the
 * setup route refuses.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { store, type Store } from "./store.ts";

const FILE = "admin.json";

/** Same parameters as the key envelope, for the same reason. */
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * A week.
 *
 * Long, deliberately. This is a home server behind a router, the threat it answers is
 * casual access on the local network rather than a stolen laptop, and an operator who has
 * to log in every hour is an operator who will set the password to `keeper`.
 */
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export const COOKIE = "dscrt_keeper_session";

interface Admin {
  v: 1;
  salt: string;
  hash: string;
}

/**
 * Live sessions, in memory only.
 *
 * A restart logs everybody out. That is the correct trade for a process that may be holding
 * an unlocked key: persisting sessions to the same volume as the key would mean a stolen
 * volume is a stolen login as well.
 */
const sessions = new Map<string, number>();

function hash(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64, SCRYPT);
}

export function isConfigured(from: Store = store): boolean {
  return from.exists(FILE);
}

export function setPassword(password: string, from: Store = store): void {
  if (password.length < 8) {
    throw new Error("Use at least 8 characters. This is the only thing guarding the key.");
  }
  const salt = randomBytes(16);
  const admin: Admin = {
    v: 1,
    salt: salt.toString("base64"),
    hash: hash(password, salt).toString("base64"),
  };
  from.writeJson(FILE, admin);
  // Changing the password ends every session. Otherwise changing it because you believe
  // somebody else has it would leave them logged in.
  sessions.clear();
}

export function verify(password: string, from: Store = store): boolean {
  const admin = from.readJson<Admin | null>(FILE, null);
  if (!admin) return false;

  const expected = Buffer.from(admin.hash, "base64");
  const actual = hash(password, Buffer.from(admin.salt, "base64"));
  // Length-checked first: `timingSafeEqual` throws rather than returns false on a mismatch,
  // and a stored hash of the wrong length is a corrupt file, not a wrong password.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function startSession(): string {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

export function endSession(token: string | null): void {
  if (token) sessions.delete(token);
}

export function validSession(token: string | null): boolean {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Read one cookie out of a request header, without a cookie-parsing dependency. */
export function sessionFrom(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

/**
 * The `Set-Cookie` value.
 *
 * `Secure` is deliberately absent. ZimaOS serves this over plain HTTP on a LAN address, and
 * a `Secure` cookie there is simply never sent — the login would appear to succeed and then
 * every subsequent request would be unauthenticated, which is a worse failure than the one
 * the flag prevents. `HttpOnly` and `SameSite=Strict` both apply and both do real work here.
 */
export function cookieHeader(token: string | null): string {
  if (token === null) {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
}
