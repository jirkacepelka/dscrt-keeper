/**
 * The keeper's key: where it comes in, and where it does not go out.
 *
 * This is the one credential the process holds. It needs gas and nothing else — every
 * message the keeper sends is permissionless, so a leaked keeper key costs the operator
 * SCRT and stalls upkeep, and cannot move user funds or change a parameter. That is the
 * reason a home server is a reasonable place for it. It is not a reason to be careless.
 *
 * ## Three ways in
 *
 * - `KEEPER_MNEMONIC` in the environment, exactly as before. Unchanged for existing
 *   deployments, and it wins over anything on disk.
 * - Typed into the console, written to `wallet.env` at mode 0600. Stored as an env line
 *   rather than a bare string so it is the same artefact an operator would have written by
 *   hand — `docker run --env-file` will take it.
 * - Typed into the console with a passphrase, written to `wallet.enc` as AES-256-GCM with
 *   a scrypt-derived key.
 *
 * ## No ways out
 *
 * Nothing here returns the phrase to a caller outside this module except `readKey`, which
 * exists so `secretjs` can build a wallet. The API layer is given `status()` — a boolean, a
 * source, and the derived address. A settings screen that can display a seed phrase is a
 * settings screen that can be made to display a seed phrase.
 *
 * ## What encryption actually buys
 *
 * It protects the file, not the volume. Anyone holding both `/data` and the container's
 * environment holds both halves. What it buys is that a NAS backup, a snapshot, a shared
 * folder or a stray `cat` is not a key — which on a home server is most of the realistic
 * exposure, and worth having. Say so plainly rather than implying more.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { store, type Store } from "./store.ts";

const PLAIN_FILE = "wallet.env";
const ENCRYPTED_FILE = "wallet.enc";
const ENV_KEY = "KEEPER_MNEMONIC";

/**
 * scrypt, at parameters that cost about a tenth of a second here and a great deal more to
 * a machine trying every passphrase in a list. `maxmem` has to be raised explicitly: Node
 * defaults to 32 MB and `N=2^15, r=8` needs exactly that, so the default fails by a byte.
 */
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type KeySource = "env" | "file" | "encrypted" | "none";

export interface KeyStatus {
  /** Whether a key exists at all, in any form. */
  configured: boolean;
  source: KeySource;
  /** Encrypted, and no passphrase has been supplied yet. The keeper reads but cannot sign. */
  locked: boolean;
  /** Settable through the console, or pinned by the environment and therefore not. */
  editable: boolean;
}

/**
 * The passphrase, once somebody has given it.
 *
 * Held in memory only. `KEEPER_PASSPHRASE` in the compose file is what makes an encrypted
 * key survive an unattended restart; without it, an operator unlocks once per restart from
 * the console and the keeper reads-only until they do.
 */
let unlocked: string | null = process.env.KEEPER_PASSPHRASE ?? null;

interface Envelope {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function derive(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

function encrypt(plaintext: string, passphrase: string): Envelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(envelope: Envelope, passphrase: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derive(passphrase, Buffer.from(envelope.salt, "base64")),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  // GCM authenticates: a wrong passphrase throws here rather than returning plausible
  // rubbish that would go on to derive a wallet nobody funded.
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Pull the phrase out of an env-file line, tolerating quotes and stray whitespace. */
function parseEnvFile(contents: string): string | null {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [name, ...rest] = trimmed.split("=");
    if (name?.trim() !== ENV_KEY) continue;
    return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

export function status(from: Store = store): KeyStatus {
  if (process.env[ENV_KEY]) {
    return { configured: true, source: "env", locked: false, editable: false };
  }
  if (from.exists(ENCRYPTED_FILE)) {
    return {
      configured: true,
      source: "encrypted",
      locked: unlocked === null || !canDecrypt(from),
      editable: true,
    };
  }
  if (from.exists(PLAIN_FILE)) {
    return { configured: true, source: "file", locked: false, editable: true };
  }
  return { configured: false, source: "none", locked: false, editable: true };
}

function canDecrypt(from: Store): boolean {
  if (unlocked === null) return false;
  try {
    const envelope = from.readJson<Envelope | null>(ENCRYPTED_FILE, null);
    if (!envelope) return false;
    decrypt(envelope, unlocked);
    return true;
  } catch {
    return false;
  }
}

/** Whether the keeper can sign right now. An encrypted key nobody has unlocked cannot. */
export function hasKey(from: Store = store): boolean {
  const state = status(from);
  return state.configured && !state.locked;
}

/**
 * The phrase itself, for `secretjs` and nothing else.
 *
 * Throws with a sentence that says what to do, because this is reached at the moment a
 * transaction was about to go out and "undefined" is not a diagnosis.
 */
export function readKey(from: Store = store): string {
  const fromEnv = process.env[ENV_KEY];
  if (fromEnv) return fromEnv;

  if (from.exists(ENCRYPTED_FILE)) {
    if (unlocked === null) {
      throw new Error(
        "The stored key is encrypted and locked. Unlock it in the console, or set KEEPER_PASSPHRASE.",
      );
    }
    const envelope = from.readJson<Envelope | null>(ENCRYPTED_FILE, null);
    if (!envelope) throw new Error(`${ENCRYPTED_FILE} could not be read.`);
    try {
      return decrypt(envelope, unlocked);
    } catch {
      throw new Error("The passphrase does not decrypt the stored key.");
    }
  }

  const plain = from.readText(PLAIN_FILE);
  const phrase = plain === null ? null : parseEnvFile(plain);
  if (phrase) return phrase;

  throw new Error("No key configured. Set KEEPER_MNEMONIC, or set one in the console.");
}

/** Supply the passphrase for an encrypted key. Returns whether it actually opened it. */
export function unlock(passphrase: string, from: Store = store): boolean {
  const previous = unlocked;
  unlocked = passphrase;
  if (canDecrypt(from)) return true;
  unlocked = previous;
  return false;
}

/**
 * Store a new key.
 *
 * Writing one form removes the other, so a phrase changed from encrypted to plain does not
 * leave the old ciphertext behind for somebody to decrypt later with a passphrase they
 * still remember.
 */
export function setKey(
  mnemonic: string,
  options: { passphrase?: string } = {},
  from: Store = store,
): void {
  const phrase = normalise(mnemonic);

  if (options.passphrase) {
    from.writeJson(ENCRYPTED_FILE, encrypt(phrase, options.passphrase));
    from.remove(PLAIN_FILE);
    unlocked = options.passphrase;
    return;
  }

  from.writeText(
    PLAIN_FILE,
    `# Written by the keeper console. Mode 0600. Treat this file as the key itself.\n${ENV_KEY}="${phrase}"\n`,
  );
  from.remove(ENCRYPTED_FILE);
}

export function forgetKey(from: Store = store): void {
  from.remove(PLAIN_FILE);
  from.remove(ENCRYPTED_FILE);
  unlocked = null;
}

/**
 * Reject what cannot be a mnemonic before it reaches a wallet.
 *
 * A BIP-39 phrase is 12, 15, 18, 21 or 24 words. Catching the count here turns a pasted
 * line with a missing word into "that is 11 words" at the moment of pasting, rather than
 * into a silently different address that receives no gas and sends no transactions.
 */
export function normalise(mnemonic: string): string {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error(`A recovery phrase is 12 or 24 words. That is ${words.length}.`);
  }
  return words.join(" ");
}
