/**
 * CAITLYN Guard — ACE graft quarantine
 *
 * Moves newly added skill, MCP, and command files out of the agent
 * graph. Config edits stay in place (legitimate maintenance).
 *
 * KEYPOINT FOR 团长 REVIEW: this is the paper's quarantine mode, not
 * process kill. Only *added* mutable grafts are moved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ComponentNode } from "./component-graph.js";

const GRAFT_CLASSES = new Set(["skill", "mcp", "command"]);

/** True when ACE should isolate this newly added vertex. */
export function isQuarantinableGraft(node: ComponentNode): boolean {
  return GRAFT_CLASSES.has(node.class);
}

/**
 * Rename grafted files into quarantineDir. Returns destination paths.
 * Failed moves are skipped so the watcher stays up.
 */
export function quarantineGraftedComponents(
  added: ComponentNode[],
  quarantineDir: string,
): string[] {
  const grafts = added.filter(isQuarantinableGraft);
  if (grafts.length === 0) return [];
  fs.mkdirSync(quarantineDir, { recursive: true });
  const moved: string[] = [];
  for (const node of grafts) {
    const dest = uniqueQuarantinePath(quarantineDir, path.basename(node.absPath));
    try {
      fs.renameSync(node.absPath, dest);
      fs.writeFileSync(
        `${dest}.caitlyn_meta.json`,
        JSON.stringify({
          original_path: node.absPath,
          class: node.class,
          quarantined_at: new Date().toISOString(),
        }),
        "utf-8",
      );
      moved.push(dest);
    } catch {
      try {
        fs.copyFileSync(node.absPath, dest);
        fs.unlinkSync(node.absPath);
        moved.push(dest);
      } catch {
        // Leave the file; the next ACE tick can retry.
      }
    }
  }
  return moved;
}

function uniqueQuarantinePath(dir: string, basename: string): string {
  const stamp = Date.now();
  let dest = path.join(dir, `${stamp}_${basename}`);
  let n = 0;
  while (fs.existsSync(dest)) {
    n += 1;
    dest = path.join(dir, `${stamp}_${n}_${basename}`);
  }
  return dest;
}
