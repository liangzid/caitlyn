/**
 * CAITLYN Agent — Hybrid Scanner
 *
 * Two-mode scanning with automatic daemon detection:
 *   Mode A (daemon):  Forwards to caitlynd daemon HTTP API when reachable.
 *   Mode B (local):   Falls back to self-contained Tier 0 + Tier 1 scanning.
 *
 * Calling chain:
 *   HybridScanner.scan(content, llmCall) → ScanResult
 *     → pings caitlynd health endpoint
 *     → if healthy: CaitlyndClient.scan(content)
 *     → if not:     local scan() from scanner.ts
 */

import { scan as localScan, type LlmCallFn } from "./scanner.js";
import { CaitlyndClient, type CaitlyndScanResult, type CaitlyndStatus } from "./caitlynd-client.js";
import { loadAntibodies, loadAntigens } from "./library.js";
import { logScan } from "./history.js";
import type { ScanResult, ScriptResult, Verdict } from "./schema.js";

// ── Config ────────────────────────────────────────────────────────

const CAITLYND_URL = process.env.CAITLYND_URL ?? "http://127.0.0.1:9070";

// ── Types ─────────────────────────────────────────────────────────

export interface HybridScanOptions {
  content: string;
  llmCall: LlmCallFn;
}

export interface HybridScanResult {
  verdict: Verdict;
  confidence: number;
  tier: 0 | 1;
  script_results: ScriptResult[];
  total_latency_us: number;
  total_tokens: number;
  /** Which backend handled this scan */
  backend: "caitlynd" | "local";
  /** Daemon-specific extra info */
  daemon_info?: {
    triggered_vaccination: boolean;
    antibody_names: string[];
  };
}

// ── Daemon health cache ───────────────────────────────────────────

let daemonHealthy: boolean | null = null;
let lastHealthCheck = 0;
const HEALTH_CACHE_MS = 10_000; // cache health result for 10s

let client: CaitlyndClient | null = null;

function getClient(): CaitlyndClient {
  if (!client) client = new CaitlyndClient(CAITLYND_URL);
  return client;
}

async function checkDaemonHealth(): Promise<boolean> {
  const now = Date.now();
  if (daemonHealthy !== null && now - lastHealthCheck < HEALTH_CACHE_MS) {
    return daemonHealthy;
  }
  try {
    daemonHealthy = await getClient().health();
  } catch {
    daemonHealthy = false;
  }
  lastHealthCheck = now;
  return daemonHealthy;
}

// ── Conversion helpers ────────────────────────────────────────────

function caitlyndResultToScanResult(
  r: CaitlyndScanResult,
  latencyUs: number,
): ScanResult {
  const scriptResults: ScriptResult[] = r.antibody_results.map((ab) => ({
    antibody_id: ab.antibody_id,
    verdict: (ab.verdict === "malicious" ? "malicious" : "benign") as Verdict,
    confidence: ab.confidence,
    reason: ab.reasoning,
    latency_us: 0, // individual timings not available from daemon
    error: null,
  }));

  return {
    verdict: r.verdict === "malicious" ? "malicious" : "benign",
    confidence: r.confidence,
    tier: 1, // daemon results are Tier 1+
    script_results: scriptResults,
    total_latency_us: latencyUs,
    total_tokens: r.total_tokens,
  };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Scan content using the best available backend.
 * Prefers caitlynd daemon when reachable, falls back to local scanning.
 */
export async function hybridScan(options: HybridScanOptions): Promise<HybridScanResult> {
  const healthy = await checkDaemonHealth();
  const scanStart = performance.now();

  if (healthy) {
    try {
      const result = await getClient().scan(options.content);

      // Log to history
      logScan(
        caitlyndResultToScanResult(result, 0),
        options.content,
        "caitlynd-daemon",
      );

      const latency = Math.round((performance.now() - scanStart) * 1000);

      return {
        verdict: result.verdict === "malicious" ? "malicious" : "benign",
        confidence: result.confidence,
        tier: 1,
        script_results: result.antibody_results.map((ab) => ({
          antibody_id: ab.antibody_id,
          verdict: (ab.verdict === "malicious" ? "malicious" : "benign") as Verdict,
          confidence: ab.confidence,
          reason: ab.reasoning,
          latency_us: 0,
          error: null,
        })),
        total_latency_us: latency,
        total_tokens: result.total_tokens,
        backend: "caitlynd",
        daemon_info: {
          triggered_vaccination: result.triggered_vaccination,
          antibody_names: result.antibody_results.map((a) => a.antibody_name),
        },
      };
    } catch (err) {
      // Daemon failed mid-scan — mark unhealthy and fall through
      daemonHealthy = false;
      lastHealthCheck = Date.now();
    }
  }

  // Local fallback
  const antibodies = loadAntibodies();
  const antigens = loadAntigens();
  const result = await localScan({
    antibodies,
    antigens,
    content: options.content,
    llmCall: options.llmCall,
  });

  return {
    verdict: result.verdict,
    confidence: result.confidence,
    tier: result.tier,
    script_results: result.script_results,
    total_latency_us: result.total_latency_us,
    total_tokens: result.total_tokens,
    backend: "local",
  };
}

/**
 * Get caitlynd daemon status information.
 * Returns null if daemon is not reachable.
 */
export async function getCaitlyndStatus(): Promise<CaitlyndStatus | null> {
  const healthy = await checkDaemonHealth();
  if (!healthy) return null;
  try {
    return await getClient().status();
  } catch {
    return null;
  }
}

/**
 * Check if caitlynd daemon is reachable and healthy.
 */
export async function isCaitlyndAvailable(): Promise<boolean> {
  return checkDaemonHealth();
}

/**
 * Force a re-check of daemon health (bypasses cache).
 */
export function resetDaemonHealth(): void {
  daemonHealthy = null;
}
