#!/usr/bin/env node
/**
 * Copy plugin and worker files into dist/ using Node fs, not Unix mkdir/cp.
 *
 * Windows cmd.exe has no mkdir -p / cp. npm run build-plugins must work there.
 * KEYPOINT-REVIEW: plugin .ts files are copied as .js because the hosts load them as scripts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Source relative to the package root, then destination relative to the package root. */
export const PLUGIN_COPY_JOBS = [
  ["src/plugins/opencode-plugin.ts", "dist/plugins/opencode-plugin.js"],
  ["src/plugins/openclaw-plugin.ts", "dist/plugins/openclaw-plugin.js"],
  ["src/scripts/tier0-worker.mjs", "dist/scripts/tier0-worker.mjs"],
];

/**
 * Copy each plugin/worker file, creating parent directories as needed.
 */
export function copyPluginBuildAssets(root = packageRoot) {
  for (const [fromRel, toRel] of PLUGIN_COPY_JOBS) {
    const from = path.join(root, fromRel);
    const to = path.join(root, toRel);
    if (!fs.existsSync(from)) {
      throw new Error(`Missing plugin source: ${from}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  copyPluginBuildAssets();
}
