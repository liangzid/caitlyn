/**
 * CAITLYN Agent — Antibody & Antigen Library
 *
 * Loads antibodies and antigens from the filesystem, maintains the forest index.
 *
 * Directory layout:
 *   antibodies/<id>/  README.md  config.yaml  detect.ts (optional)
 *   antibodies/index.json
 *   antigens/<id>/    README.md  config.yaml  payload.txt
 *   antigens/index.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AntibodyEntry,
  AntibodyConfig,
  AntigenEntry,
  AntigenConfig,
  AntibodyIndex,
  AntigenIndex,
  AntibodyStats,
} from "./schema.js";

// ── Paths ─────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");
const ANTIBODIES_DIR = path.join(PKG_ROOT, "antibodies");
const ANTIGENS_DIR = path.join(PKG_ROOT, "antigens");

// ── Simple YAML parser (no external dep needed for our flat configs) ──

function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentNested: Record<string, unknown> | null = null;
  let nestedKey = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Nested line (indented under a parent key that had an empty value)
    if (indent >= 2 && currentNested !== null) {
      // YAML list item: "- value"
      if (trimmed.startsWith("- ")) {
        const itemValue = coerceValue(trimmed.slice(2).trim());
        const listKey = `_list_${nestedKey}`;
        const list = (currentNested[listKey] as unknown[]) ?? [];
        list.push(itemValue);
        currentNested[listKey] = list;
        continue;
      }
      // Regular nested key: "key: value"
      const colon = trimmed.indexOf(":");
      if (colon !== -1) {
        const key = trimmed.slice(0, colon).trim();
        const rawValue = trimmed.slice(colon + 1).trim();
        currentNested[key] = coerceValue(rawValue);
      }
      continue;
    }

    // Top-level line — resets nesting context
    currentNested = null;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();

    if (rawValue === "") {
      // Empty value → this key opens a nested block (object or list)
      currentNested = {};
      nestedKey = key;
      out[key] = currentNested;
    } else if (rawValue === "null") {
      // Explicit null scalar
      out[key] = null;
    } else {
      out[key] = coerceValue(rawValue);
    }
  }

  return out;
}

function coerceValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  let v: string = raw;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (/^-?\d+\.?\d*$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "" || v === "null") return null;
  return v;
}

/**
 * Normalize a parsed YAML config: convert _list_* keys to arrays,
 * and ensure required nested objects (stats) have defaults.
 */
function normalizeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  for (const [key, value] of Object.entries(out)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = value as Record<string, unknown>;
    for (const [nk, nv] of Object.entries(nested)) {
      if (!nk.startsWith("_list_")) continue;
      const realName = nk.slice(6);
      out[realName] = nv;
      if (key !== realName && Object.keys(nested).every((k) => k.startsWith("_list_"))) {
        delete out[key];
      }
    }
  }

  // Ensure stats has defaults
  if (!out.stats || typeof out.stats !== "object") {
    out.stats = { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 };
  }

  return out;
}

// ── Load Antibodies ───────────────────────────────────────────────

export function loadAntibodies(): AntibodyEntry[] {
  if (!fs.existsSync(ANTIBODIES_DIR)) return [];
  const entries: AntibodyEntry[] = [];

  for (const dirName of fs.readdirSync(ANTIBODIES_DIR)) {
    const dirPath = path.join(ANTIBODIES_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const configPath = path.join(dirPath, "config.yaml");
    const readmePath = path.join(dirPath, "README.md");
    const scriptPath = path.join(dirPath, "detect.ts");

    if (!fs.existsSync(configPath)) continue;

    const configRaw = fs.readFileSync(configPath, "utf-8");
    const rawConfig = parseYaml(configRaw);
    const config = normalizeConfig(rawConfig) as unknown as AntibodyConfig;

    const readme = fs.existsSync(readmePath)
      ? fs.readFileSync(readmePath, "utf-8")
      : "";

    const hasScript = fs.existsSync(scriptPath);

    entries.push({
      config,
      readme,
      scriptPath: hasScript ? scriptPath : null,
      folderPath: dirPath,
    });
  }

  return entries;
}

export function saveAntibody(entry: AntibodyEntry): void {
  const dirPath = entry.folderPath;
  fs.mkdirSync(dirPath, { recursive: true });

  const configLines: string[] = [];
  for (const [key, value] of Object.entries(entry.config)) {
    if (key === "stats") {
      configLines.push("stats:");
      for (const [sk, sv] of Object.entries(entry.config.stats)) {
        configLines.push(`  ${sk}: ${sv}`);
      }
    } else if (key === "deps") {
      configLines.push("deps:");
      for (const d of entry.config.deps) {
        configLines.push(`  - ${d}`);
      }
    } else {
      const v = value === null ? "null" : typeof value === "string" ? `"${value}"` : String(value);
      configLines.push(`${key}: ${v}`);
    }
  }
  fs.writeFileSync(path.join(dirPath, "config.yaml"), configLines.join("\n"), "utf-8");
  fs.writeFileSync(path.join(dirPath, "README.md"), entry.readme, "utf-8");
}

// ── Load Antigens ─────────────────────────────────────────────────

export function loadAntigens(): AntigenEntry[] {
  if (!fs.existsSync(ANTIGENS_DIR)) return [];
  const entries: AntigenEntry[] = [];

  for (const dirName of fs.readdirSync(ANTIGENS_DIR)) {
    const dirPath = path.join(ANTIGENS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const configPath = path.join(dirPath, "config.yaml");
    const readmePath = path.join(dirPath, "README.md");
    const payloadPath = path.join(dirPath, "payload.txt");

    if (!fs.existsSync(configPath)) continue;

    const configRaw = fs.readFileSync(configPath, "utf-8");
    const config = parseYaml(configRaw) as unknown as AntigenConfig;

    const readme = fs.existsSync(readmePath)
      ? fs.readFileSync(readmePath, "utf-8")
      : "";

    const payload = fs.existsSync(payloadPath)
      ? fs.readFileSync(payloadPath, "utf-8")
      : "";

    entries.push({ config, readme, payload, folderPath: dirPath });
  }

  return entries;
}

// ── Forest Index ──────────────────────────────────────────────────

export function buildAntibodyIndex(antibodies: AntibodyEntry[]): AntibodyIndex {
  const index: AntibodyIndex = { roots: [], trees: {} };

  for (const ab of antibodies) {
    index.trees[ab.config.id] = {
      id: ab.config.id,
      children: [],
      stats_aggregated: { ...ab.config.stats },
    };
  }

  for (const ab of antibodies) {
    if (ab.config.parent_id && index.trees[ab.config.parent_id]) {
      index.trees[ab.config.parent_id].children.push(ab.config.id);
    } else if (!ab.config.parent_id) {
      index.roots.push(ab.config.id);
    }
  }

  aggregateStats(index);
  return index;
}

function aggregateStats(index: AntibodyIndex): void {
  function aggregate(id: string): AntibodyStats {
    const node = index.trees[id];
    if (!node) return { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 };
    const merged: AntibodyStats = { ...node.stats_aggregated };
    for (const childId of node.children) {
      const childStats = aggregate(childId);
      merged.total_scans += childStats.total_scans;
      merged.true_positives += childStats.true_positives;
      merged.false_positives += childStats.false_positives;
      merged.avg_latency_us = Math.max(merged.avg_latency_us, childStats.avg_latency_us);
    }
    node.stats_aggregated = merged;
    return merged;
  }
  for (const root of index.roots) {
    aggregate(root);
  }
}

export function buildAntigenIndex(antigens: AntigenEntry[]): AntigenIndex {
  const entries: AntigenIndex["entries"] = {};
  for (const ag of antigens) {
    entries[ag.config.id] = {
      id: ag.config.id,
      category: ag.config.category,
      escapes: ag.config.escapes,
    };
  }
  return { entries };
}

// ── Index persistence ─────────────────────────────────────────────

export function saveAntibodyIndex(index: AntibodyIndex): void {
  fs.mkdirSync(ANTIBODIES_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ANTIBODIES_DIR, "index.json"),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}

export function loadAntibodyIndex(): AntibodyIndex | null {
  const p = path.join(ANTIBODIES_DIR, "index.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as AntibodyIndex;
}

export function saveAntigenIndex(index: AntigenIndex): void {
  fs.mkdirSync(ANTIGENS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ANTIGENS_DIR, "index.json"),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}
