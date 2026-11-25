/**
 * CAITLYN Guard — structured audit logging.
 *
 * Audit records are JSONL and intentionally exclude raw tool content. They
 * preserve the decision, scan metadata, detector outcomes, and a digest of
 * the truncated snippet for correlation without creating a second secret store.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GuardEvent } from "./types.js";

export const GUARD_AUDIT_SCHEMA_VERSION = 1;

/**
 * Metadata is allow-listed rather than copied wholesale.
 * KEYPOINT-REVIEW: future audit fields must be added consciously so a raw tool
 * payload cannot accidentally become part of the local audit log.
 */
const AUDIT_METADATA_KEYS = new Set([
  "hookPoint",
  "toolName",
  "error",
  "inputError",
  "filePath",
  "fileType",
]);

function safeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of AUDIT_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string") safe[key] = value.slice(0, 240);
    else if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

/** Resolve the audit directory: environment, configured path, then default. */
export function resolveGuardAuditDir(configuredDir?: string | null): string {
  const override = process.env.CAITLYN_AUDIT_DIR?.trim();
  const selected = override || configuredDir?.trim() || path.join(os.homedir(), ".caitlyn", "audit");
  if (selected === "~") return os.homedir();
  if (selected.startsWith("~/")) return path.join(os.homedir(), selected.slice(2));
  return path.resolve(selected);
}

/** Append one privacy-safe guard audit record. Audit failure never blocks scanning. */
export function appendGuardAuditEvent(event: GuardEvent, auditDir: string): void {
  try {
    const snippet = event.content_snippet ?? "";
    const record = {
      schema_version: GUARD_AUDIT_SCHEMA_VERSION,
      timestamp: event.timestamp,
      mode: event.mode,
      source: event.source,
      action: event.action,
      scan: {
        verdict: event.scan_result.verdict,
        confidence: event.scan_result.confidence,
        tier: event.scan_result.tier,
        latency_us: event.scan_result.total_latency_us,
        tokens: event.scan_result.total_tokens,
        cost_usd: event.scan_result.total_cost_usd ?? 0,
        detectors: event.scan_result.script_results.map((result) => ({
          id: result.defense_skill_id,
          verdict: result.verdict,
          confidence: result.confidence,
          latency_us: result.latency_us,
          error: result.error,
        })),
      },
      content: {
        snippet_sha256: crypto.createHash("sha256").update(snippet).digest("hex"),
        snippet_bytes: Buffer.byteLength(snippet, "utf-8"),
        truncated: snippet.length >= 256,
      },
      metadata: safeAuditMetadata(event.metadata),
    };
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(auditDir, "guard-events.jsonl"),
      `${JSON.stringify(record)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Audit is important, but a disk failure must not disable enforcement.
  }
}

/** Create the guard event callback when audit is enabled. */
export function createGuardAuditLogger(
  enabled: boolean,
  configuredDir?: string | null,
): ((event: GuardEvent) => void) | undefined {
  if (!enabled) return undefined;
  const auditDir = resolveGuardAuditDir(configuredDir);
  return (event) => appendGuardAuditEvent(event, auditDir);
}
