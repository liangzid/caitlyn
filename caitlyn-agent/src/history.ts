/**
 * CAITLYN Agent — Scan History & Dashboard
 *
 * Persists scan results to a local JSON log and provides
 * aggregated cost/stats for the dashboard.
 *
 * Calling chain:
 *   scan() → logScan(result)       — append to scan log
 *   dashboard() → getDashboard()   — compute aggregated stats
 *   scan_history() → getHistory()  — load recent entries
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanResult, Verdict } from "./schema.js";

import * as os from "node:os";

// ── Paths ─────────────────────────────────────────────────────────

const HISTORY_DIR = path.join(os.homedir(), ".caitlyn");
const HISTORY_PATH = path.join(HISTORY_DIR, "scan_history.json");

// Ensure directory exists at module load
try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch { /* ignore */ }

// ── Types ─────────────────────────────────────────────────────────

export interface ScanLogEntry {
  timestamp: string;
  content_hash: string;
  content_preview: string;
  verdict: Verdict;
  confidence: number;
  tier: 0 | 1;
  total_latency_us: number;
  total_tokens: number;
  antibody_hits: string[];
  source: string;
}

export interface DashboardStats {
  total_scans: number;
  malicious_count: number;
  benign_count: number;
  detection_rate: number;
  avg_latency_ms: number;
  avg_tokens: number;
  total_tokens: number;
  tier0_hits: number;
  tier1_hits: number;
  last_scan_at: string | null;
  top_antibodies: Array<{ id: string; hits: number }>;
}

// ── Internal helpers ──────────────────────────────────────────────

function hashContent(content: string): string {
  // Simple djb2 hash for content dedup
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Write lock (prevents concurrent read-modify-write races) ─────

let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => T): Promise<T> {
  const prev = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(() => {
    try {
      const result = fn();
      return result;
    } finally {
      release();
    }
  });
}

export function loadHistory(): ScanLogEntry[] {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf-8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`⚠️  scan_history.json is not an array — resetting`);
      return [];
    }
    return parsed as ScanLogEntry[];
  } catch (err) {
    console.warn(`⚠️  Failed to load scan history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function saveHistory(entries: ScanLogEntry[]): void {
  const trimmed = entries.slice(-10000);
  const tmpPath = HISTORY_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(trimmed, null, 2), "utf-8");
  fs.renameSync(tmpPath, HISTORY_PATH);
}

// ── Public API ────────────────────────────────────────────────────

/** Log a scan result to persistent history (serialized via write lock). */
export async function logScan(
  result: ScanResult,
  content: string,
  source: string = "caitlyn-agent",
): Promise<void> {
  await withLock(() => {
    const entries = loadHistory();
    const antibodyHits = result.script_results
      .filter((r) => r.verdict === "malicious")
      .map((r) => r.antibody_id);

    entries.push({
      timestamp: new Date().toISOString(),
      content_hash: hashContent(content),
      content_preview: content.slice(0, 120),
      verdict: result.verdict,
      confidence: result.confidence,
      tier: result.tier,
      total_latency_us: result.total_latency_us,
      total_tokens: result.total_tokens,
      antibody_hits: antibodyHits,
      source,
    });

    saveHistory(entries);
  });
}

/** Get recent scan history entries. */
export function getHistory(limit: number = 20): ScanLogEntry[] {
  const entries = loadHistory();
  return entries.slice(-limit).reverse();
}

/** Compute aggregated dashboard statistics. */
export function getDashboard(): DashboardStats {
  const entries = loadHistory();

  if (entries.length === 0) {
    return {
      total_scans: 0,
      malicious_count: 0,
      benign_count: 0,
      detection_rate: 0,
      avg_latency_ms: 0,
      avg_tokens: 0,
      total_tokens: 0,
      tier0_hits: 0,
      tier1_hits: 0,
      last_scan_at: null,
      top_antibodies: [],
    };
  }

  const malicious = entries.filter((e) => e.verdict === "malicious");
  const benign = entries.filter((e) => e.verdict === "benign");
  const totalLatencyUs = entries.reduce((s, e) => s + e.total_latency_us, 0);
  const totalTokens = entries.reduce((s, e) => s + e.total_tokens, 0);

  // Top antibodies by hit count
  const abCounts = new Map<string, number>();
  for (const e of entries) {
    for (const abId of e.antibody_hits) {
      abCounts.set(abId, (abCounts.get(abId) ?? 0) + 1);
    }
  }
  const topAntibodies = [...abCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, hits]) => ({ id, hits }));

  return {
    total_scans: entries.length,
    malicious_count: malicious.length,
    benign_count: benign.length,
    detection_rate: entries.length > 0 ? malicious.length / entries.length : 0,
    avg_latency_ms: entries.length > 0
      ? totalLatencyUs / entries.length / 1000
      : 0,
    avg_tokens: entries.length > 0
      ? totalTokens / entries.length
      : 0,
    total_tokens: totalTokens,
    tier0_hits: entries.filter((e) => e.tier === 0 && e.verdict === "malicious").length,
    tier1_hits: entries.filter((e) => e.tier === 1 && e.verdict === "malicious").length,
    last_scan_at: entries[entries.length - 1].timestamp,
    top_antibodies: topAntibodies,
  };
}

/** Clear all scan history entries (serialized via write lock). */
export async function clearHistory(): Promise<void> {
  await withLock(() => {
    const tmpPath = HISTORY_PATH + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify([], null, 2), "utf-8");
    fs.renameSync(tmpPath, HISTORY_PATH);
  });
}

/** Export scan history to a JSON file at the given path. */
export function exportHistory(filePath: string): number {
  const entries = loadHistory();
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  return entries.length;
}
