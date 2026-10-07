/**
 * CAITLYN privacy vault.
 *
 * Surrogates produced for secrets and format-preserving tokens are stored
 * only on the local machine. The map file holds AES-GCM ciphertext, not
 * the original value. Metric-DP numbers are not stored: Prεεmpt leaves
 * those noisy values in place.
 *
 * KEYPOINT-REVIEW: the process keeps opened originals in memory so a later
 * tool call in the same process can restore them. A memory dump of the
 * caitlyn-hook process can recover those values.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface VaultFile {
  version: 1;
  entries: Record<string, string>;
}

/**
 * Local key and sealed surrogate map.
 */
export class PrivacyVault {
  private readonly memory = new Map<string, string>();
  private loaded = false;

  /**
   * Create a vault. `rootDir` set means the key and map are persisted there.
   */
  constructor(
    readonly key: Buffer,
    readonly rootDir: string | undefined,
    readonly random: () => number,
  ) {}

  /**
   * Open or create the vault directory under `rootDir`.
   */
  static open(rootDir: string, random?: () => number): PrivacyVault {
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(rootDir, "privacy.key");
    let key: Buffer;
    if (fs.existsSync(keyPath)) {
      key = fs.readFileSync(keyPath);
      if (key.length < 32) throw new Error("caitlyn privacy key is shorter than 32 bytes");
      key = key.subarray(0, 32);
    } else {
      key = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
    }
    return new PrivacyVault(key, rootDir, random ?? (() => {
      const buf = crypto.randomBytes(4);
      return (buf.readUInt32BE(0) + 1) / 0x100000001;
    }));
  }

  /**
   * Build an in-memory vault for tests. Nothing is written to disk.
   */
  static memory(key: Buffer, random?: () => number): PrivacyVault {
    return new PrivacyVault(key, undefined, random ?? (() => 0.5));
  }

  /**
   * Remember a surrogate. The original is sealed before it touches disk.
   */
  remember(surrogate: string, original: string): void {
    if (surrogate === original) return;
    this.memory.set(surrogate, original);
    if (!this.rootDir) return;
    this.withLock(() => {
      const file = this.readFile();
      file.entries[surrogate] = seal(this.key, original);
      this.writeFile(file);
    });
  }

  /**
   * Return the original for a surrogate previously remembered here.
   */
  lookup(surrogate: string): string | undefined {
    const cached = this.memory.get(surrogate);
    if (cached !== undefined) return cached;
    if (!this.rootDir) return undefined;
    this.ensureLoaded();
    return this.memory.get(surrogate);
  }

  /**
   * List known surrogates, longest first, so a short token cannot eat a longer one.
   */
  surrogates(): string[] {
    this.ensureLoaded();
    return [...this.memory.keys()].sort((a, b) => b.length - a.length);
  }

  /**
   * Load sealed entries into memory once.
   */
  private ensureLoaded(): void {
    if (this.loaded || !this.rootDir) return;
    this.loaded = true;
    const file = this.readFile();
    for (const [surrogate, sealed] of Object.entries(file.entries)) {
      if (this.memory.has(surrogate)) continue;
      try {
        this.memory.set(surrogate, openSeal(this.key, sealed));
      } catch {
        // Skip a damaged entry rather than failing the whole tool call.
      }
    }
  }

  /**
   * Read the map file, or an empty map when it does not exist yet.
   */
  private readFile(): VaultFile {
    const mapPath = this.mapPath();
    if (!fs.existsSync(mapPath)) return { version: 1, entries: {} };
    const parsed = JSON.parse(fs.readFileSync(mapPath, "utf-8")) as VaultFile;
    if (!parsed.entries || typeof parsed.entries !== "object") return { version: 1, entries: {} };
    return parsed;
  }

  /**
   * Atomically replace the map file.
   */
  private writeFile(file: VaultFile): void {
    const mapPath = this.mapPath();
    const tmp = `${mapPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    fs.renameSync(tmp, mapPath);
  }

  /**
   * Hold an exclusive lock file for the read-modify-write of the map.
   */
  private withLock(body: () => void): void {
    if (!this.rootDir) {
      body();
      return;
    }
    const lockPath = path.join(this.rootDir, "privacy-map.lock");
    const started = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        try {
          body();
        } finally {
          fs.closeSync(fd);
          fs.rmSync(lockPath, { force: true });
        }
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        if (Date.now() - started > 2000) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }

  /**
   * Path of the sealed map inside the vault directory.
   */
  private mapPath(): string {
    if (!this.rootDir) throw new Error("memory vault has no map path");
    return path.join(this.rootDir, "privacy-map.json");
  }
}

/**
 * Seal a string with AES-256-GCM. Layout is iv || tag || ciphertext.
 */
function seal(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Open a value produced by `seal`.
 */
function openSeal(key: Buffer, blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
