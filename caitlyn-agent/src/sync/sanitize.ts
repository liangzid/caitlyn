/**
 * CAITLYN — Sanitize library entries before contribution packing.
 *
 * Strips operational stats and local paths. Attack payloads are hashed
 * by default; full payload only when the user opts in per entry.
 */

import { createHash } from "node:crypto";
import type { DefenseSkillConfig, AttackConfig } from "../schema.js";

/** Zero stats and drop fields that are local-only noise. */
export function sanitizeDefenseSkillConfig(config: DefenseSkillConfig): DefenseSkillConfig {
  return {
    ...config,
    stats: {
      total_scans: 0,
      true_positives: 0,
      false_positives: 0,
      avg_latency_us: 0,
    },
  };
}

/** Copy attack config as-is (ids/lineage are intentional). */
export function sanitizeAttackConfig(config: AttackConfig): AttackConfig {
  return { ...config };
}

/** Hash payload for the default redacted contribution form. */
export function hashPayload(payload: string): string {
  const digest = createHash("sha256").update(payload, "utf-8").digest("hex");
  return [
    "# Redacted attack payload (sha256 + length). Full text omitted by default.",
    `sha256: ${digest}`,
    `bytes: ${Buffer.byteLength(payload, "utf-8")}`,
    "",
  ].join("\n");
}

/** Strip obvious absolute paths and home-dir leaks from free text. */
export function scrubLocalPaths(text: string): string {
  return text
    .replace(/\/home\/[^\s"'`]+/g, "<redacted-path>")
    .replace(/\/Users\/[^\s"'`]+/g, "<redacted-path>")
    .replace(/[A-Z]:\\Users\\[^\s"'`]+/gi, "<redacted-path>");
}
