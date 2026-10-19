/**
 * CAITLYN Guard — Agent component graph inventory
 *
 * ACE (arxiv:2605.11442) watches mutable vertices: skills, MCP
 * descriptions, configs, slash commands. This inventory walks real
 * agent directories and diffs successive snapshots. The first snapshot
 * is the clean baseline, not a mutation burst.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ComponentClass = "skill" | "mcp" | "config" | "command" | "other";

export interface ComponentNode {
  relPath: string;
  absPath: string;
  class: ComponentClass;
  mtimeMs: number;
  size: number;
}

export interface ComponentGraphSnapshot {
  nodes: Map<string, ComponentNode>;
}

export interface ComponentGraphDiff {
  added: ComponentNode[];
  removed: ComponentNode[];
  changed: ComponentNode[];
  /** First-order ACE energy: mutation event count on mutable classes. */
  energy: number;
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  ".cache",
]);

const MAX_FILES = 2000;
const MAX_DEPTH = 5;

/**
 * Classify a path relative to an agent root into an ACE vertex class.
 */
export function classifyComponentPath(relPath: string): ComponentClass {
  const n = relPath.replace(/\\/g, "/").toLowerCase();
  if (n.endsWith("skill.md") || n.includes("/skills/") || n.startsWith("skills/")) {
    return "skill";
  }
  if (
    n.includes("mcp") ||
    n.endsWith("claude_desktop_config.json")
  ) {
    return "mcp";
  }
  if (n.includes("/commands/") || n.startsWith("commands/")) {
    return "command";
  }
  if (/(^|\/)(settings|config|hooks)\.(json|toml|ya?ml)$/.test(n)) {
    return "config";
  }
  return "other";
}

/** Mutable ACE classes get full mutation weight. */
export function isMutableComponentClass(cls: ComponentClass): boolean {
  return cls !== "other";
}

/**
 * Walk agent roots and record file vertices. Missing roots are skipped.
 */
export function inventoryComponentGraph(
  roots: string[],
  maxFiles: number = MAX_FILES,
): ComponentGraphSnapshot {
  const nodes = new Map<string, ComponentNode>();
  for (const root of roots) {
    walkRoot(root, root, 0, nodes, maxFiles);
  }
  return { nodes };
}

/**
 * Diff two inventories. Energy counts add/remove/change on mutable classes.
 */
export function diffComponentGraph(
  previous: ComponentGraphSnapshot | null,
  current: ComponentGraphSnapshot,
): ComponentGraphDiff {
  if (previous === null) {
    return { added: [], removed: [], changed: [], energy: 0 };
  }
  const added: ComponentNode[] = [];
  const removed: ComponentNode[] = [];
  const changed: ComponentNode[] = [];
  for (const [key, node] of current.nodes) {
    const before = previous.nodes.get(key);
    if (!before) added.push(node);
    else if (before.mtimeMs !== node.mtimeMs || before.size !== node.size) {
      changed.push(node);
    }
  }
  for (const [key, node] of previous.nodes) {
    if (!current.nodes.has(key)) removed.push(node);
  }
  const energy =
    countMutable(added) + countMutable(removed) + countMutable(changed);
  return { added, removed, changed, energy };
}

function countMutable(nodes: ComponentNode[]): number {
  return nodes.filter((n) => isMutableComponentClass(n.class)).length;
}

function walkRoot(
  root: string,
  current: string,
  depth: number,
  nodes: Map<string, ComponentNode>,
  maxFiles: number,
): void {
  if (nodes.size >= maxFiles || depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (nodes.size >= maxFiles) return;
    if (entry.name.startsWith(".") && entry.name !== ".mcp.json") continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkRoot(root, full, depth + 1, nodes, maxFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const relPath = path.relative(root, full);
    const key = `${path.resolve(root)}:${relPath}`;
    nodes.set(key, {
      relPath,
      absPath: full,
      class: classifyComponentPath(relPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
}
