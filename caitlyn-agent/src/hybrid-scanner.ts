/**
 * CAITLYN Agent — Scanner (Local-only)
 *
 * Always uses local scanning. The Rust daemon has been removed;
 * all evolution logic now lives in src/evolution/.
 */
import { scan as localScan, type LlmCallFn } from "./scanner.js";
import { loadAntibodies, loadAntigens } from "./library.js";
import type { ScanResult } from "./schema.js";
import { loadScanningConfig } from "./config.js";
import type { EscalationPolicy, SourceTrust } from "./escalation.js";

// ── Types ─────────────────────────────────────────────────────────

export interface HybridScanOptions {
  content: string;
  llmCall: LlmCallFn;
  sourceTrust?: SourceTrust;
  highRisk?: boolean;
  escalationPolicy?: EscalationPolicy;
  fastDetectorIds?: string[];
  weakSignalThreshold?: number;
}

export interface HybridScanResult extends ScanResult {
  backend: "local";
  daemon_info: null;
}

// ── Public API ─────────────────────────────────────────────────────

/** Scan content using the local scanner. */
export async function hybridScan(options: HybridScanOptions): Promise<HybridScanResult> {
  const scanning = loadScanningConfig();
  const result = await localScan({
    content: options.content,
    llmCall: options.llmCall,
    antibodies: loadAntibodies(),
    antigens: loadAntigens(),
    sourceTrust: options.sourceTrust ?? scanning.sourceTrust,
    highRisk: options.highRisk ?? scanning.highRisk,
    escalationPolicy: options.escalationPolicy ?? scanning.policy,
    fastDetectorIds: options.fastDetectorIds ?? scanning.fastDetectorIds,
    weakSignalThreshold:
      options.weakSignalThreshold ?? scanning.weakSignalThreshold,
  });

  return {
    ...result,
    backend: "local",
    daemon_info: null,
  };
}

/** Always returns null — daemon has been removed. */
export async function getCaitlyndStatus(): Promise<null> {
  return null;
}

/** Always returns false — daemon has been removed. */
export async function isCaitlyndAvailable(): Promise<boolean> {
  return false;
}

/** No-op — daemon has been removed. */
export function resetDaemonHealth(): void {}
