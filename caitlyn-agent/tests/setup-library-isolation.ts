/**
 * Vitest setup: redirect the antibody/antigen library to a private copy
 * for every worker by default. Tests that need the real repository
 * library (library.test.ts) explicitly remove the env var; tests that
 * need a custom library override it in their own beforeEach.
 *
 * This removes all env/module-reload races between parallel workers.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SHARED = path.join(os.tmpdir(), "caitlyn-lib-shared");
const LOCK = `${SHARED}.lock`;

// Copy the real library once into a shared location, guarded by an
// atomic lock so parallel workers do not race each other.
if (!fs.existsSync(path.join(SHARED, "antibodies"))) {
  for (let i = 0; i < 200; i++) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch {
      // Another worker holds the lock; wait briefly.
      execSync("sleep 0.05");
    }
  }
  if (fs.existsSync(LOCK) && !fs.existsSync(path.join(SHARED, "antibodies"))) {
    fs.mkdirSync(SHARED, { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, "antibodies"), path.join(SHARED, "antibodies"), {
      recursive: true,
    });
    fs.cpSync(path.join(REPO_ROOT, "antigens"), path.join(SHARED, "antigens"), {
      recursive: true,
    });
    try {
      fs.rmdirSync(LOCK);
    } catch {
      // Lock already removed by a racing worker.
    }
  }
}

process.env.CAITLYN_LIBRARY_DIR = SHARED;
