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

// ── Simple YAML parser imported from yaml-parser.ts ───────────────

import { parseYaml, coerceValue } from "./yaml-parser.js";

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

// ── Config Validation ──────────────────────────────────────────────

const VALID_CATEGORIES = ["injection", "jailbreak", "poisoning", "exfiltration"] as const;
const VALID_TIERS = [0, 1] as const;

function assertString(v: unknown, field: string): string {
  if (typeof v === "string") return v;
  if (v != null) return String(v);
  throw new Error(`Missing required field: ${field}`);
}

function assertNumber(v: unknown, field: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v != null) throw new Error(`Expected number for field "${field}", got ${typeof v}`);
  throw new Error(`Missing required field: ${field}`);
}

function assertStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return String(v);
}

function assertStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((item) => String(item));
  if (v != null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (key.startsWith("_list_") && Array.isArray(val)) return val.map((item) => String(item));
    }
  }
  return [];
}

function assertCategory(v: unknown, field: string): AntibodyConfig["category"] {
  const s = assertString(v, field).toLowerCase();
  if ((VALID_CATEGORIES as readonly string[]).includes(s)) {
    return s as AntibodyConfig["category"];
  }
  throw new Error(`Invalid ${field}: "${s}". Must be one of: ${VALID_CATEGORIES.join(", ")}`);
}

function assertTier(v: unknown): 0 | 1 {
  const n = assertNumber(v, "tier");
  if (n === 0 || n === 1) return n;
  throw new Error(`Invalid tier: ${n}. Must be 0 or 1.`);
}

function defaultStats(raw: unknown): AntibodyStats {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const s = raw as Record<string, unknown>;
    return {
      total_scans: typeof s.total_scans === "number" ? s.total_scans : 0,
      true_positives: typeof s.true_positives === "number" ? s.true_positives : 0,
      false_positives: typeof s.false_positives === "number" ? s.false_positives : 0,
      avg_latency_us: typeof s.avg_latency_us === "number" ? s.avg_latency_us : 0,
    };
  }
  return { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 };
}

/**
 * Validate and coerce a raw config object into a properly typed AntibodyConfig.
 * Throws descriptive errors for missing or invalid required fields.
 */
export function validateAntibodyConfig(raw: Record<string, unknown>): AntibodyConfig {
  return {
    id: assertString(raw.id, "id"),
    name: assertString(raw.name, "name"),
    parent_id: assertStringOrNull(raw.parent_id),
    category: assertCategory(raw.category, "category"),
    tier: assertTier(raw.tier),
    threshold: assertNumber(raw.threshold, "threshold"),
    created_at: assertString(raw.created_at, "created_at"),
    generation: typeof raw.generation === "number" ? raw.generation : 0,
    stats: defaultStats(raw.stats),
    deps: assertStringArray(raw.deps),
  };
}

/**
 * Validate and coerce a raw config object into a properly typed AntigenConfig.
 * Throws descriptive errors for missing or invalid required fields.
 */
export function validateAntigenConfig(raw: Record<string, unknown>): AntigenConfig {
  return {
    id: assertString(raw.id, "id"),
    name: assertString(raw.name, "name"),
    category: assertCategory(raw.category, "category"),
    injection_point: assertString(raw.injection_point, "injection_point"),
    target_agent: assertString(raw.target_agent, "target_agent"),
    attack_template: assertString(raw.attack_template, "attack_template"),
    created_at: assertString(raw.created_at, "created_at"),
    parent_id: assertStringOrNull(raw.parent_id),
    escapes: assertStringArray(raw.escapes),
  };
}


// ── Caching (avoid redundant disk I/O on every tool call) ──────────

let _cachedAntibodies: AntibodyEntry[] | null = null;
let _cachedAntigens: AntigenEntry[] | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5_000;

function cacheExpired(): boolean {
  return Date.now() - _cacheTime > CACHE_TTL_MS;
}

// ── Load Antibodies ───────────────────────────────────────────────

export function loadAntibodies(): AntibodyEntry[] {
  if (!cacheExpired() && _cachedAntibodies) return _cachedAntibodies;
  if (!fs.existsSync(ANTIBODIES_DIR)) {
    console.warn(`⚠️  Antibodies directory not found: ${ANTIBODIES_DIR}`);
    return [];
  }
  const entries: AntibodyEntry[] = [];

  for (const dirName of fs.readdirSync(ANTIBODIES_DIR)) {
    const dirPath = path.join(ANTIBODIES_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const configPath = path.join(dirPath, "config.yaml");
    const readmePath = path.join(dirPath, "README.md");
    const scriptPath = path.join(dirPath, "detect.ts");

    if (!fs.existsSync(configPath)) {
      console.warn(`⚠️  Skipping antibody '${dirName}': no config.yaml`);
      continue;
    }

    try {
      const configRaw = fs.readFileSync(configPath, "utf-8");
      const rawConfig = parseYaml(configRaw);
      const config = validateAntibodyConfig(normalizeConfig(rawConfig));

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
    } catch (err) {
      console.warn(`⚠️  Skipping antibody '${dirName}': failed to load config — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  _cachedAntibodies = entries;
  _cacheTime = Date.now();
  return entries;
}

function yamlEscape(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  const s = String(value);
  // Use double-quoted string with proper escaping
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
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
        configLines.push(`  - ${yamlEscape(d)}`);
      }
    } else {
      configLines.push(`${key}: ${yamlEscape(value)}`);
    }
  }
  fs.writeFileSync(path.join(dirPath, "config.yaml"), configLines.join("\n"), "utf-8");
  _cachedAntibodies = null; // invalidate cache
}

export function loadAntigens(): AntigenEntry[] {
  if (!cacheExpired() && _cachedAntigens) return _cachedAntigens;
  if (!fs.existsSync(ANTIGENS_DIR)) {
    console.warn(`⚠️  Antigens directory not found: ${ANTIGENS_DIR}`);
    _cachedAntigens = [];
    _cacheTime = Date.now();
    return [];
  }
  const entries: AntigenEntry[] = [];

  for (const dirName of fs.readdirSync(ANTIGENS_DIR)) {
    const dirPath = path.join(ANTIGENS_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const configPath = path.join(dirPath, "config.yaml");
    const readmePath = path.join(dirPath, "README.md");
    const payloadPath = path.join(dirPath, "payload.txt");

    if (!fs.existsSync(configPath)) {
      console.warn(`⚠️  Skipping antigen '${dirName}': no config.yaml`);
      continue;
    }

    try {
      const configRaw = fs.readFileSync(configPath, "utf-8");
      const rawConfig = parseYaml(configRaw);
      const config = validateAntigenConfig(normalizeConfig(rawConfig));

      const readme = fs.existsSync(readmePath)
        ? fs.readFileSync(readmePath, "utf-8")
        : "";

      const payload = fs.existsSync(payloadPath)
        ? fs.readFileSync(payloadPath, "utf-8")
        : "";

      entries.push({ config, readme, payload, folderPath: dirPath });
    } catch (err) {
      console.warn(`⚠️  Skipping antigen '${dirName}': failed to load config — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  _cachedAntigens = entries;
  _cacheTime = Date.now();
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
    let weightedLatencySum = merged.avg_latency_us * merged.total_scans;
    for (const childId of node.children) {
      const childStats = aggregate(childId);
      merged.total_scans += childStats.total_scans;
      merged.true_positives += childStats.true_positives;
      merged.false_positives += childStats.false_positives;
      weightedLatencySum += childStats.avg_latency_us * childStats.total_scans;
    }
    merged.avg_latency_us = merged.total_scans > 0 ? weightedLatencySum / merged.total_scans : 0;
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
