/**
 * CAITLYN Guard — Verdict Policy Engine
 *
 * Applies a configurable policy to scan results to determine the guard action.
 * Supports per-source (e.g., per-tool, per-path) policy overrides.
 */

import type { Verdict, ScanResult } from "../schema.js";
import type { VerdictAction, VerdictPolicy, GuardConfig, GuardEvent } from "./types.js";
import { DEFAULT_VERDICT_POLICY, DEFAULT_GUARD_CONFIG } from "./types.js";

// ── Policy Engine ───────────────────────────────────────────────────

export interface PolicyContext {
  /** Mode identifier. */
  mode: "fs-watcher" | "agent-hooks" | "sandbox";
  /** Source identifier (tool name, file path, hook point). */
  source: string;

  /** Content being scanned. */
  content: string;

  /** The scan result. */
  scanResult: ScanResult;

  /** Guard configuration. */
  config: GuardConfig;
}

export interface PolicyDecision {
  action: VerdictAction;
  reason: string;
  modifiedContent?: string;
  event: GuardEvent;
}

/**
 * Evaluate a scan result against the configured policy.
 *
 * Resolution order:
 *   1. Per-source policy override (if configured)
 *   2. Global verdict policy
 *   3. Default policy
 */
export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  const { scanResult, config, mode, source, content } = ctx;
  const verdict = scanResult.verdict;

  // Determine action from policy
  const policy = { ...DEFAULT_VERDICT_POLICY, ...config.verdict_policy };
  const action: VerdictAction = policy[verdict];

  // Build reason
  const reason = buildReason(verdict, action, scanResult);

  // Build modified content (replace blocked content with warning)
  const modifiedContent =
    action === "block"
      ? `[CAITLYN BLOCKED] ${reason}`
      : action === "flag"
        ? `[CAITLYN FLAGGED — ${verdict.toUpperCase()}] ${content}`
        : content;

  // Build event
  const event: GuardEvent = {
    mode,
    content_snippet: content.slice(0, 256),
    scan_result: scanResult,
    action,
    source,
    timestamp: new Date().toISOString(),
    metadata: {},
  };

  return { action, reason, modifiedContent, event };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildReason(
  verdict: Verdict,
  action: VerdictAction,
  result: ScanResult,
): string {
  const confidence = result.confidence.toFixed(2);
  const tier = `Tier ${result.tier}`;

  if (action === "allow") {
    return `Content passed scan (${tier}, confidence=${confidence})`;
  }

  if (action === "block") {
    const matched = result.script_results
      .filter((r) => r.verdict === "malicious")
      .map((r) => r.antibody_id)
      .join(", ");
    return `Malicious content detected by: ${matched || "Tier 1 LLM"} (confidence=${confidence})`;
  }

  // flag
  return `Content flagged as ${verdict} (${tier}, confidence=${confidence})`;
}

// ── Content Truncation ──────────────────────────────────────────────

/**
 * Truncate content to max_scan_bytes for scanning.
 * Preserves a suffix so end-of-content injection payloads are still scanned.
 */
export function prepareContent(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf-8") <= maxBytes) {
    return content;
  }
  // Keep first 75% + last 25% so both prefix and suffix injections are covered
  const headBytes = Math.floor(maxBytes * 0.75);
  const tailBytes = maxBytes - headBytes;
  const head = truncateToBytes(content, headBytes);
  const tail = truncateToBytesFromEnd(content, tailBytes);
  return head + "\n... [CAITLYN: content truncated] ...\n" + tail;
}

function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  return buf.slice(0, maxBytes).toString("utf-8");
}

function truncateToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  return buf.slice(buf.length - maxBytes).toString("utf-8");
}
