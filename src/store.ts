/**
 * The keeper's data directory.
 *
 * The keeper used to write nothing at all, and that was a real property rather than an
 * oversight: a container with no volume cannot lose anything, corrupt anything, or leak
 * anything through a backup. It is given up here for three things it could not otherwise
 * have — a record of what it sent, settings reachable from a console, and drift baselines
 * that survive a restart.
 *
 * What is kept in exchange:
 *
 * **Nothing here is required.** Every read tolerates an absent directory and returns the
 * fallback, and the directory is created on the first *write* rather than at startup. A
 * `--check-only` run against a read-only filesystem must still work, because that run is
 * the health probe and it has no business needing a disk.
 *
 * **Writes are atomic.** Temp file, then rename, which is atomic within a filesystem on
 * every platform this runs on. A NAS losing power mid-write is a normal event on a home
 * server, and the failure it must never produce is a half-written `config.json` that stops
 * the keeper from starting at all.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Where the data lives.
 *
 * `/data` in the container, set by the Dockerfile. Relative to the working directory
 * otherwise, so a developer running `npm start` gets `./data` and not a permission error
 * against the root of their disk.
 */
export const DATA_DIR = process.env.KEEPER_DATA_DIR ?? "data";

/** Owner-only, for anything that has been near a key. */
const PRIVATE = 0o600;

export class Store {
  readonly dir: string;

  constructor(dir: string = DATA_DIR) {
    this.dir = dir;
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  /**
   * Whether this directory can actually be written to.
   *
   * Asked rather than assumed, so the console can say "settings cannot be saved — no volume
   * is mounted" instead of failing at the moment somebody presses Save.
   */
  get writable(): boolean {
    try {
      this.ensure();
      const probe = this.path(".writable");
      writeFileSync(probe, "", { mode: PRIVATE });
      rmSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  private ensure() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  readText(name: string): string | null {
    try {
      return readFileSync(this.path(name), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Write, atomically.
   *
   * The temp file carries the same mode as the target: a mnemonic must not exist as
   * world-readable even for the microsecond before the rename.
   */
  writeText(name: string, contents: string, mode: number = PRIVATE): void {
    this.ensure();
    const target = this.path(name);
    const temp = `${target}.tmp`;
    writeFileSync(temp, contents, { mode });
    renameSync(temp, target);
  }

  appendText(name: string, contents: string): void {
    this.ensure();
    appendFileSync(this.path(name), contents, { mode: PRIVATE });
  }

  remove(name: string): void {
    try {
      rmSync(this.path(name));
    } catch {
      // Already gone is the outcome the caller wanted.
    }
  }

  /**
   * Read JSON, falling back rather than throwing.
   *
   * A corrupt file returns the fallback and does not stop the keeper. Upkeep is the job;
   * losing a drift baseline or a page of history is not a reason to stop doing it, and a
   * keeper that refuses to start because of its own cache is worse than one that forgets.
   */
  readJson<T>(name: string, fallback: T): T {
    const raw = this.readText(name);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(name: string, value: unknown, mode: number = PRIVATE): void {
    this.writeText(name, `${JSON.stringify(value, null, 2)}\n`, mode);
  }
}

/** The one every module shares, so they cannot disagree about where the data is. */
export const store = new Store();
