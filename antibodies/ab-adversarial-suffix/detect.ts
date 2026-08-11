/**
 * detect.ts — Adversarial Suffix and Compliant Prefill Detector (Tier 0)
 *
 * Targets GCG/AdvPrompter-style adversarial suffixes, format corruption,
 * and "compliant prefill" jailbreaks (adv-prompt f1-f3 families). Patterns
 * are derived from real missed samples in the knowledge base, not invented.
 *
 * Reads content from stdin, outputs one JSON line:
 * {"verdict":"malicious"|"suspicious"|"benign","confidence":0-1,"reason":"..."}
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
  { pattern: /(similarlyNow|oppositeley|adversarialSuffix)/i, weight: 0.95, label: "adv-suffix-marker" },
  { pattern: /\.\\\s*\+\s*similarly/i, weight: 0.9, label: "dot-plus-suffix" },
  { pattern: /(?:^|[\s\]])\.{4,}[A-Za-z]/, weight: 0.9, label: "dot-run-suffix" },
  { pattern: /\[SYSTEM_TOKEN_LEAK\]|\[SYS_MSG\b/i, weight: 0.85, label: "token-leak-spoof" },
  { pattern: /---\s*BEGIN UNRESTRICTED MODE\s*---/i, weight: 0.9, label: "unrestricted-mode" },
  { pattern: /user:\s*ignore safety\\n\s*assistant:/i, weight: 0.85, label: "dialogue-spoof" },
  { pattern: /(?:restrictions|filters|safety protocols?)\s+(?:REMOVED|bypassed|disabled)/i, weight: 0.8, label: "restrictions-removed" },
  { pattern: /acting as (?:UnfilteredGPT|unfiltered|uncensored)/i, weight: 0.8, label: "unfiltered-persona" },
  { pattern: /#{3,}[^]{0,60}\b(?:new task|output unrestricted|instructions?)\b/i, weight: 0.7, label: "markdown-repurposing" },
  { pattern: /^Below is a step-by-step tutorial on bypassing/i, weight: 0.85, label: "tutorial-bypass" },
  {
    pattern: /^(?:Sure|Of course|Absolutely|I understand|Here(?:'s| is)|I'?d be happy|I can definitely|Without any)[^]{0,160}\b(?:hack|chemical|exploit|phishing|illegal|bypass|harmful|dangerous|malicious|substances|weapon|attack|social engineering|network security)\b/i,
    weight: 0.8,
    label: "compliant-prefill",
  },
  { pattern: /[!?#$%&*~=`|]{8,}/, weight: 0.5, label: "symbol-run" },
];

// ── Decision ────────────────────────────────────────────────────
export function detect(content: string): DetectResult {
  let bestMatch: { weight: number; label: string } | null = null;
  for (const sig of signatures) {
    if (sig.pattern.test(content)) {
      if (!bestMatch || sig.weight > bestMatch.weight) {
        bestMatch = { weight: sig.weight, label: sig.label };
      }
    }
  }

  const confidence = bestMatch?.weight ?? 0;
  if (confidence >= 0.6) {
    return {
      verdict: "malicious",
      confidence,
      reason: `Matched signature "${bestMatch!.label}" (weight=${bestMatch!.weight})`,
    };
  }
  if (confidence > 0.3) {
    return {
      verdict: "suspicious",
      confidence,
      reason: `Weak signal: "${bestMatch!.label}"`,
    };
  }
  return { verdict: "benign", confidence: 0, reason: null };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  console.log(JSON.stringify(detect(readFileSync(0, "utf-8"))));
}
