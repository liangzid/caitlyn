/**
 * detect.ts — General Injection Detector (Tier 0)
 *
 * Fast heuristic/regex-based detection of prompt injection attacks.
 *
 * Dual mode:
 *   - imported (resident worker): export function detect(content)
 *   - direct run (node detect.mjs): reads stdin, prints one JSON line
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export interface DetectResult {
  verdict: "benign" | "suspicious" | "malicious";
  confidence: number;
  reason: string | null;
}

// ── Signature patterns ──────────────────────────────────────────
const signatures: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, weight: 0.95, label: "ignore-previous" },
  { pattern: /you\s+are\s+now\s+(DAN|an?\s+unaligned)/i, weight: 0.95, label: "role-hijack" },
  { pattern: /pretend\s+you\s+are/i, weight: 0.8, label: "pretend-role" },
  { pattern: /act\s+as\s+(if\s+)?(you\s+are\s+)?(DAN|a\s+different)/i, weight: 0.8, label: "act-as" },
  { pattern: /\[SYSTEM\]/i, weight: 0.7, label: "system-tag" },
  { pattern: /<\|im_start\|>/i, weight: 0.9, label: "im-start" },
  { pattern: /<system>/i, weight: 0.7, label: "system-xml" },
  { pattern: /DROP\s+TABLE/i, weight: 0.9, label: "drop-table" },
  { pattern: /UNION\s+SELECT/i, weight: 0.85, label: "union-select" },
  { pattern: /OR\s+1\s*=\s*1/i, weight: 0.6, label: "or-1=1" },
  { pattern: /;\s*--\s*$/im, weight: 0.5, label: "sql-comment" },
  { pattern: /\beval\s*\(/i, weight: 0.8, label: "eval-call" },
  { pattern: /\bsubprocess\s*\./i, weight: 0.8, label: "subprocess" },
  { pattern: /\bos\.system\b/i, weight: 0.8, label: "os-system" },
  { pattern: /\bexec\s*\(/i, weight: 0.7, label: "exec-call" },
  { pattern: /rm\s+-rf\s+\//i, weight: 0.95, label: "rm-rf" },
  { pattern: /curl\s+.*\|\s*(ba)?sh/i, weight: 0.95, label: "curl-pipe" },
  { pattern: /wget\s+.*-O\s*-\s*\|/i, weight: 0.9, label: "wget-pipe" },
  { pattern: /your\s+(real|actual|true)\s+(task|job|purpose|goal)\s+is/i, weight: 0.85, label: "real-task" },
  { pattern: /instead\s+of\s+(following|obeying)/i, weight: 0.8, label: "instead-of" },
  { pattern: /forget\s+(everything|all|your)\s+(above|previous)/i, weight: 0.9, label: "forget-all" },
  { pattern: /new\s+instructions?\s*(:|=|are)/i, weight: 0.75, label: "new-instructions" },
  { pattern: /from\s+now\s+on\s*(,|you)/i, weight: 0.65, label: "from-now-on" },
  { pattern: /send\s+(this|the|all)\s+(to|data)\s+\S+@\S+/i, weight: 0.9, label: "exfil-email" },
  { pattern: /curl\s+.*http.*\$\w+/i, weight: 0.85, label: "curl-exfil" },
];

export function detect(content: string): DetectResult {
  // ── Additional heuristic flags ──────────────────────────────────
  let heuristicScore = 0;
  const flags: string[] = [];

  // Check ratio of suspicious characters (common in encoded payloads)
  const suspiciousChars = (content.match(/[<>{}|;&`$]/g) ?? []).length;
  if (suspiciousChars > content.length * 0.15) {
    heuristicScore += 0.3;
    flags.push("high-suspicious-chars");
  }

  // Check for unusually long single-line (common in encoded payloads)
  const maxLineLen = Math.max(...content.split("\n").map((l) => l.length));
  if (maxLineLen > 1000) {
    heuristicScore += 0.1;
    flags.push("long-single-line");
  }

  // ── Match signatures ────────────────────────────────────────────
  let bestMatch: { weight: number; label: string } | null = null;
  for (const sig of signatures) {
    if (sig.pattern.test(content)) {
      if (!bestMatch || sig.weight > bestMatch.weight) {
        bestMatch = { weight: sig.weight, label: sig.label };
      }
      flags.push(`sig:${sig.label}`);
    }
  }

  // ── Decision ────────────────────────────────────────────────────
  const baseConfidence = bestMatch ? bestMatch.weight : heuristicScore;
  const finalConfidence = Math.min(1.0, baseConfidence + heuristicScore * 0.2);

  if (finalConfidence >= 0.6) {
    const reason = bestMatch
      ? `Matched signature "${bestMatch.label}" (weight=${bestMatch.weight})` +
        (heuristicScore > 0 ? ` + heuristics=${heuristicScore.toFixed(2)}` : "")
      : `Heuristic flags: ${flags.join(", ")}`;
    return { verdict: "malicious", confidence: finalConfidence, reason };
  }
  if (finalConfidence > 0.3) {
    // Weak signal — report as suspicious so guards can flag it
    return {
      verdict: "suspicious",
      confidence: finalConfidence,
      reason: `Weak signals: ${flags.join(", ")}`,
    };
  }
  return { verdict: "benign", confidence: 0, reason: null };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  console.log(JSON.stringify(detect(readFileSync(0, "utf-8"))));
}
