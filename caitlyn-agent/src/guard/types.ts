/**
 * CAITLYN Guard — Shared Types
 * Type definitions shared across all guard modes:
 * FS Watcher, Agent Hooks, Process Sandbox.
 */

import type { Verdict, ScanResult } from "../schema.js";

// ── Verdict Action ──────────────────────────────────────────────────

/** What the guard does with content after scanning. */
export type VerdictAction = "allow" | "block" | "flag";

/** Map a scan verdict to the guard action. */
export function verdictToAction(
  verdict: Verdict,
  policy?: Partial<VerdictPolicy>,
): VerdictAction {
  const p = { ...DEFAULT_VERDICT_POLICY, ...policy };
  return p[verdict];
}

// ── Verdict Policy ──────────────────────────────────────────────────

/** Per-verdict actions configurable by the operator. */
export interface VerdictPolicy {
  benign: VerdictAction;
  suspicious: VerdictAction;
  malicious: VerdictAction;
}

export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  benign: "allow",
  suspicious: "flag",
  malicious: "block",
};

// ── Guard Event ─────────────────────────────────────────────────────

/** Unified event emitted by all guard modes when a scan completes. */
export interface GuardEvent {
  /** Which guard mode produced this event. */
  mode: "fs-watcher" | "agent-hooks" | "sandbox";
  /** Content that was scanned (truncated to 256 chars for logging). */
  content_snippet: string;

  /** The scan result. */
  scan_result: ScanResult;

  /** The action taken. */
  action: VerdictAction;

  /** Source identifier (tool name, file path, hook point, syscall). */
  source: string;

  /** ISO timestamp. */
  timestamp: string;

  /** Mode-specific metadata. */
  metadata: Record<string, unknown>;
}

// ── Guard Config ────────────────────────────────────────────────────

/** Common configuration for all guard modes. */
export interface GuardConfig {
  /** Whether the guard is enabled. */
  enabled: boolean;

  /** Verdict policy overrides. */
  verdict_policy?: Partial<VerdictPolicy>;

  /** Scan timeout in milliseconds. */
  scan_timeout_ms: number;

  /** Maximum content length to scan (bytes). Longer content is truncated. */
  max_scan_bytes: number;

  /** Callback for guard events (logging, alerting). */
  onEvent?: (event: GuardEvent) => void;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enabled: true,
  scan_timeout_ms: 5000,
  max_scan_bytes: 65536, // 64KB
};
