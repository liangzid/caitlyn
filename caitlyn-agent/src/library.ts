/**
 * CAITLYN Agent — Antibody & Antigen Library
 *
 * Loads antibodies and antigens from the filesystem, maintains the forest index.
 *
 * Dual-root layout (production):
 *   shipped: <repo-or-package>/antibodies|antigens   (curated, read-mostly)
 *   user:    ~/.caitlyn/library/antibodies|antigens  (local edits / evolution)
 * Scanner unions both roots; user entries override shipped by id.
 *
 * Single-root (tests): CAITLYN_LIBRARY_DIR points at one root for read+write.
 *
 * Per-entry layout:
 *   antibodies/<id>/  README.md  config.yaml  detect.ts (optional)
 *   antigens/<id>/    README.md  config.yaml  payload.txt
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AntibodyEntry,
  AntibodyConfig,
  AntigenEntry,
  AntigenConfig,
  AntibodyIndex,
  AntibodyStats,
  AntibodyRole,
  Verdict,
} from "./schema.js";

// ── Paths ─────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(__dirname, "../..");

/** True when tests redirect the whole library to one isolated root. */
export function isSingleLibraryMode(): boolean {
  if (!process.env.CAITLYN_LIBRARY_DIR) return false;
  if (process.env.CAITLYN_USER_LIBRARY_DIR) {
    return (
      path.resolve(process.env.CAITLYN_LIBRARY_DIR) ===
      path.resolve(process.env.CAITLYN_USER_LIBRARY_DIR)
    );
  }
  return true;
}

/**
 * Curated library root shipped with the package / repo checkout.
 * CAITLYN_LIBRARY_DIR overrides shipped root (and is single-root unless USER differs).
 */
export function shippedLibraryRoot(): string {
  if (process.env.CAITLYN_LIBRARY_DIR) {
    return path.resolve(process.env.CAITLYN_LIBRARY_DIR);
  }
  const projectAntibodies = path.join(PROJECT_ROOT, "antibodies");
  if (fs.existsSync(projectAntibodies)) return PROJECT_ROOT;
  return PKG_ROOT;
}

/**
 * Writable user library root (~/.caitlyn/library).
 * When CAITLYN_LIBRARY_DIR is set alone, user root equals that dir (test isolation).
 */
export function userLibraryRoot(): string {
  if (process.env.CAITLYN_USER_LIBRARY_DIR) {
    return path.resolve(process.env.CAITLYN_USER_LIBRARY_DIR);
  }
  if (process.env.CAITLYN_LIBRARY_DIR) {
    return path.resolve(process.env.CAITLYN_LIBRARY_DIR);
  }
  return path.join(os.homedir(), ".caitlyn", "library");
}

/** Writable antibody directory (user root; same as shipped in single-root mode). */
export function antibodiesDir(): string {
  return path.join(userLibraryRoot(), "antibodies");
}

/** Writable antigen directory (user root; same as shipped in single-root mode). */
export function antigensDir(): string {
  return path.join(userLibraryRoot(), "antigens");
}

/** Shipped curated antibody directory. */
export function shippedAntibodiesDir(): string {
  return path.join(shippedLibraryRoot(), "antibodies");
}

/** Shipped curated antigen directory. */
export function shippedAntigensDir(): string {
  return path.join(shippedLibraryRoot(), "antigens");
}

/** Whether folderPath lives under the shipped (non-user) tree in dual-root mode. */
export function isShippedLibraryPath(folderPath: string): boolean {
  if (isSingleLibraryMode()) return false;
  const shipped = path.resolve(shippedLibraryRoot());
  const resolved = path.resolve(folderPath);
  return resolved === shipped || resolved.startsWith(shipped + path.sep);
}

// ── Simple YAML parser imported from yaml-parser.ts ───────────────

import { parseYaml, coerceValue } from "./yaml-parser.js";

/**
 * Normalize a parsed YAML config: convert _list_* keys to arrays,
 * and ensure required nested objects (stats) have defaults.
 */
function normalizeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  // Flatten single-key nested objects that are just list wrappers.
  // Example: {deps: {deps: ["node", "tsx"]}} → {deps: ["node", "tsx"]}
  for (const [key, value] of Object.entries(out)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const nestedKeys = Object.keys(nested);
      if (nestedKeys.length === 1 && nestedKeys[0] === key && Array.isArray(nested[key])) {
        out[key] = nested[key];
      }
    }
  }

  // Handle legacy _list_* keys from old YAML parser (backward compat)
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
  if (!out.stats || typeof out.stats !== "object" || Array.isArray(out.stats)) {
    out.stats = { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 };
  }

  return out;
}
// ── Config Validation ──────────────────────────────────────────────
const VALID_CATEGORIES = ["injection", "jailbreak", "poisoning", "exfiltration", "unknown", "tool_misuse"] as const;
const VALID_TIERS = [0, 1, 2] as const;

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

function assertTier(v: unknown): 0 | 1 | 2 {
  const n = assertNumber(v, "tier");
  if (n === 0 || n === 1 || n === 2) return n;
  throw new Error(`Invalid tier: ${n}. Must be 0, 1, or 2.`);
}

function assertRole(v: unknown): AntibodyRole {
  if (v === undefined || v === null) return "detector";
  const s = String(v);
  if (s === "detector" || s === "non_detector") return s;
  throw new Error(`Invalid role: "${s}". Must be detector or non_detector.`);
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
    description: typeof raw.description === "string" ? raw.description : String(raw.description ?? ""),
    // The prompt is the executable knowledge for Tier 1/2 antibodies.
    // Keep it first-class so saves never drop it (this was previously dead data).
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    role: assertRole(raw.role),
    affinity_score: typeof raw.affinity_score === "number" ? raw.affinity_score : 0,
    created_at: assertString(raw.created_at, "created_at"),
    generation: typeof raw.generation === "number" ? raw.generation : 0,
    stats: defaultStats(raw.stats),
    deps: assertStringArray(raw.deps),
    signatures: Array.isArray(raw.signatures) ? raw.signatures as AntibodyConfig["signatures"] : [],
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
const CACHE_TTL_MS = 30_000;

function cacheExpired(): boolean {
  return Date.now() - _cacheTime > CACHE_TTL_MS;
}

/** Invalidate the antibody/antigen caches (after external edits). */
export function invalidateLibraryCache(): void {
  _cachedAntibodies = null;
  _cachedAntigens = null;
  _cacheTime = 0;
}

// ── Load Antibodies ───────────────────────────────────────────────

/** Load antibody entries from one directory (no cache). */
function loadAntibodiesFromDir(dir: string): AntibodyEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: AntibodyEntry[] = [];

  for (const dirName of fs.readdirSync(dir)) {
    const dirPath = path.join(dir, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    // Skip hidden/trash directories (e.g. .trash for recoverable removals).
    if (dirName.startsWith(".")) continue;

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
  return entries;
}

/**
 * Merge shipped then user antibodies; user wins on id collision.
 * KEYPOINT-REVIEW: dual-root is the production trust split; tests stay single-root via CAITLYN_LIBRARY_DIR.
 */
export function loadAntibodies(): AntibodyEntry[] {
  if (!cacheExpired() && _cachedAntibodies) return _cachedAntibodies;

  let entries: AntibodyEntry[];
  if (isSingleLibraryMode()) {
    const dir = antibodiesDir();
    if (!fs.existsSync(dir)) {
      console.warn(`⚠️  Antibodies directory not found: ${dir}`);
      entries = [];
    } else {
      entries = loadAntibodiesFromDir(dir);
    }
  } else {
    const byId = new Map<string, AntibodyEntry>();
    for (const ab of loadAntibodiesFromDir(shippedAntibodiesDir())) {
      byId.set(ab.config.id, ab);
    }
    for (const ab of loadAntibodiesFromDir(antibodiesDir())) {
      byId.set(ab.config.id, ab);
    }
    entries = [...byId.values()];
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

/**
 * Persist an antibody under the writable user root.
 * If the entry still points at a shipped path, copy-on-write into the user library.
 */
export function saveAntibody(entry: AntibodyEntry): void {
  if (process.env.CAITLYN_TEST_TRACE) {
    fs.appendFileSync(
      "/tmp/caitlyn-trace.log",
      `[saveAntibody pid=${process.pid} dir=${entry.folderPath}]\n${new Error().stack}\n`,
    );
  }
  if (isShippedLibraryPath(entry.folderPath)) {
    const dest = path.join(antibodiesDir(), entry.config.id);
    fs.mkdirSync(dest, { recursive: true });
    if (fs.existsSync(entry.folderPath)) {
      for (const name of fs.readdirSync(entry.folderPath)) {
        if (name === "config.yaml") continue;
        fs.cpSync(path.join(entry.folderPath, name), path.join(dest, name), {
          recursive: true,
        });
      }
    }
    entry.folderPath = dest;
    if (entry.scriptPath) {
      const scriptName = path.basename(entry.scriptPath);
      entry.scriptPath = path.join(dest, scriptName);
    }
  }

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
    } else if (key === "signatures") {
      // Signatures are objects; serialize as a YAML list so the config
      // round-trips through the parser instead of becoming a JSON string.
      configLines.push("signatures:");
      for (const sig of entry.config.signatures) {
        configLines.push(`  - pattern: ${yamlEscape(sig.pattern)}`);
        configLines.push(`    type: ${yamlEscape(sig.type)}`);
        configLines.push(`    label: ${yamlEscape(sig.label)}`);
      }
    } else {
      configLines.push(`${key}: ${yamlEscape(value)}`);
    }
  }
  fs.writeFileSync(path.join(dirPath, "config.yaml"), configLines.join("\n"), "utf-8");
  _cachedAntibodies = null; // invalidate cache
  // Rebuild and persist the antibody index so the new antibody is immediately visible
  const all = loadAntibodies();
  saveAntibodyIndex(buildAntibodyIndex(all));
}

/** Load antigen entries from one directory (no cache). */
function loadAntigensFromDir(dir: string): AntigenEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: AntigenEntry[] = [];

  for (const dirName of fs.readdirSync(dir)) {
    const dirPath = path.join(dir, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    if (dirName.startsWith(".")) continue;

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
  return entries;
}

/**
 * Merge shipped then user antigens; user wins on id collision.
 */
export function loadAntigens(): AntigenEntry[] {
  if (!cacheExpired() && _cachedAntigens) return _cachedAntigens;

  let entries: AntigenEntry[];
  if (isSingleLibraryMode()) {
    const dir = antigensDir();
    if (!fs.existsSync(dir)) {
      console.warn(`⚠️  Antigens directory not found: ${dir}`);
      entries = [];
    } else {
      entries = loadAntigensFromDir(dir);
    }
  } else {
    const byId = new Map<string, AntigenEntry>();
    for (const ag of loadAntigensFromDir(shippedAntigensDir())) {
      byId.set(ag.config.id, ag);
    }
    for (const ag of loadAntigensFromDir(antigensDir())) {
      byId.set(ag.config.id, ag);
    }
    entries = [...byId.values()];
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
  // NOTE: buildAntibodyIndex is a PURE function — it must not persist.
  // Callers that need the index on disk (saveAntibody, vaccination,
  // stale-index healing) must call saveAntibodyIndex explicitly.
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

// ── Index persistence ─────────────────────────────────────────────

export function saveAntibodyIndex(index: AntibodyIndex): void {
  fs.mkdirSync(antibodiesDir(), { recursive: true });
  fs.writeFileSync(
    path.join(antibodiesDir(), "index.json"),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}

export function loadAntibodyIndex(): AntibodyIndex | null {
  const p = path.join(antibodiesDir(), "index.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as AntibodyIndex;
    // Treat empty index (no roots, no trees) as stale — return null so caller rebuilds
    if (!parsed.roots || parsed.roots.length === 0) return null;
    // Dual-root: user-side index can lag behind newly shipped skills.
    // If the live library has ids the index does not know, force rebuild.
    const live = loadAntibodies();
    const indexed = new Set(Object.keys(parsed.trees ?? {}));
    for (const ab of live) {
      if (!indexed.has(ab.config.id)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** One antibody's participation in a scan, for feedback accounting. */
export interface AntibodyFeedback {
  antibody_id: string;
  verdict: Verdict;
  confidence: number;
  latency_us: number;
  /** True when this antibody's verdict is a hard malicious vote. */
  fired: boolean;
}

/**
 * Record scan feedback to update antibody stats.
 *
 * Called after each scan with EVERY participating antibody (Tier 0 and
 * Tier 1), so total_scans reflects real participation instead of only
 * counting antibodies that happened to fire. TP/FP are counted only for
 * fired votes: a fired vote on a scan that ended malicious is a true
 * positive; a fired vote on a scan that did not end malicious is a
 * false positive. This gives the evolution loop per-antibody signal.
 *
 * REVIEW(团长): TP/FP 是相对"最终判定"的代理标签，不是 ground truth；
 * 有标注的评测集（如 AgentEval）下应优先用真实标签覆盖此统计。
 */
export function recordScanFeedback(
  results: AntibodyFeedback[],
  finalVerdict: Verdict,
): void {
  for (const r of results) {
    const antibody = loadAntibodies().find((a) => a.config.id === r.antibody_id);
    if (!antibody) continue;
    const stats = antibody.config.stats;
    stats.total_scans = (stats.total_scans ?? 0) + 1;
    if (r.fired) {
      if (finalVerdict === "malicious") {
        stats.true_positives = (stats.true_positives ?? 0) + 1;
      } else {
        stats.false_positives = (stats.false_positives ?? 0) + 1;
      }
    }
    // Update rolling average latency
    stats.avg_latency_us = stats.total_scans > 1
      ? (stats.avg_latency_us * (stats.total_scans - 1) + r.latency_us) / stats.total_scans
      : r.latency_us;
    // Persist immediately so stats survive the library cache and restarts.
    saveAntibody(antibody);
  }
}

/**
 * Check that every antibody in the library is actually executable by the
 * scanner: Tier 0 detectors need detect.ts or signatures; Tier 1/2
 * detectors need a prompt; non-detectors need at least one artifact.
 * Also catches duplicate ids and duplicate runtime signatures.
 *
 * Returns a list of issues; an empty list means the library is sound.
 */
export function checkLibraryIntegrity(entries: AntibodyEntry[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const seenTier0Signatures = new Set<string>();

  for (const ab of entries) {
    if (seenIds.has(ab.config.id)) {
      issues.push(`duplicate antibody id: ${ab.config.id}`);
    }
    seenIds.add(ab.config.id);

    const hasScript = Boolean(ab.scriptPath);
    const hasPrompt = ab.config.prompt.trim().length > 0;
    const hasSignatures = ab.config.signatures.length > 0;

    // Every signature in the library must compile, even for non-detector
    // roles: they are still consumed by the evolution pipeline as context.
    for (const sig of ab.config.signatures) {
      if (sig.type === "regex") {
        try {
          // eslint-disable-next-line no-new
          new RegExp(sig.pattern);
        } catch {
          issues.push(
            `${ab.config.id}: malformed regex signature "${sig.label ?? sig.pattern}"`,
          );
        }
      }
    }

    if (ab.config.role === "detector") {
      if (ab.config.tier === 0 && !hasScript && !hasSignatures) {
        issues.push(
          `${ab.config.id}: tier 0 detector without detect.ts or signatures`,
        );
      }
      if (ab.config.tier > 0 && !hasPrompt) {
        issues.push(`${ab.config.id}: tier ${ab.config.tier} detector without prompt`);
      }
      // Runtime signatures matter for signature-only Tier 0 detectors;
      // duplicate patterns there waste votes and skew stats.
      if (ab.config.tier === 0 && !hasScript) {
        for (const sig of ab.config.signatures) {
          const key = `${sig.type}:${sig.pattern}`;
          if (seenTier0Signatures.has(key)) {
            issues.push(
              `duplicate tier 0 signature ${key} (${ab.config.id})`,
            );
          }
          seenTier0Signatures.add(key);
        }
      }
    } else if (!hasPrompt && !hasScript && !hasSignatures) {
      issues.push(
        `${ab.config.id}: non-detector without any implementation (prompt/script/signatures)`,
      );
    }
  }
  return issues;
}
