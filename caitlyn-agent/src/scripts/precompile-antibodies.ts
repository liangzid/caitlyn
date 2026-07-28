/**
 * Precompile antibody detect.ts scripts to .mjs for faster Tier 0 execution.
 *
 * npx tsx detect.ts → ~500ms overhead
 * node detect.mjs    → ~50ms overhead
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname!, "../../..");
const ANTIBODIES_DIR = path.join(PROJECT_ROOT, "antibodies");
const AGENT_DIR = path.join(PROJECT_ROOT, "caitlyn-agent");
const TSC = path.join(AGENT_DIR, "node_modules", ".bin", "tsc");
const TYPE_ROOTS = path.join(AGENT_DIR, "node_modules", "@types");

function precompileDir(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      precompileDir(fullPath);
      continue;
    }
    if (entry.name !== "detect.ts") continue;

    const tsconfig = path.join(dir, "tsconfig.detect.json");
    const jsOut = path.join(dir, "detect.js");
    const mjsOut = path.join(dir, "detect.mjs");

    // Remove stale outputs
    try { fs.unlinkSync(jsOut); } catch { /* ok */ }
    try { fs.unlinkSync(mjsOut); } catch { /* ok */ }

    fs.writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        outDir: ".",
        strict: false,
        noEmitOnError: false,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [TYPE_ROOTS],
      },
      files: ["detect.ts"],
    }, null, 2), "utf-8");

    const result = spawnSync(TSC, ["-p", tsconfig], {
      cwd: dir,
      timeout: 30_000,
      env: { ...process.env },
    });

    try { fs.unlinkSync(tsconfig); } catch { /* ok */ }

    if (fs.existsSync(jsOut)) {
      fs.renameSync(jsOut, mjsOut);
      console.log(`  ✅ ${path.relative(PROJECT_ROOT, fullPath)} → detect.mjs`);
    } else {
      const err = result.stderr.toString().trim().slice(0, 300);
      console.log(`  ⚠️  ${path.relative(PROJECT_ROOT, fullPath)} — ${err || `exit code ${result.status}`}`);
    }
  }
}

console.log("Precompiling antibody detect.ts scripts...");
precompileDir(ANTIBODIES_DIR);
console.log("Done.");
