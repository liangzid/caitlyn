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

function precompileDir(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      precompileDir(fullPath);
      continue;
    }
    if (entry.name === "detect.ts") {
      const outFile = path.join(dir, "detect.mjs");
      const tsconfig = path.join(dir, "tsconfig.detect.json");

      // Write a minimal tsconfig for this single file
      fs.writeFileSync(tsconfig, JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: ".",
          strict: true,
        },
        files: ["detect.ts"],
      }, null, 2), "utf-8");

      const result = spawnSync("npx", ["tsc", "-p", tsconfig], {
        cwd: dir,
        timeout: 30_000,
      });

      // Clean up tsconfig
      try { fs.unlinkSync(tsconfig); } catch { /* ok */ }

      if (result.status === 0 && fs.existsSync(outFile)) {
        console.log(`  ✅ ${path.relative(PROJECT_ROOT, fullPath)} → detect.mjs`);
      } else {
        const err = result.stderr.toString().slice(0, 200);
        console.log(`  ⚠️  ${path.relative(PROJECT_ROOT, fullPath)} — compile failed: ${err || "unknown"}`);
      }
    }
  }
}

console.log("Precompiling antibody detect.ts scripts...");
precompileDir(ANTIBODIES_DIR);
console.log("Done.");
