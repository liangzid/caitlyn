/**
 * detect.ts — Persona Hijack Detector (Tier 0)
 *
 * Detects role-play jailbreaks that try to make the agent adopt an
 * unrestricted persona (DAN/STAN/EVIL-GPT/Loki/debug-mode and similar).
 * Derived from the dir-inj-a2 missed family in the knowledge base.
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

const signatures: Array<{ pattern: RegExp; weight: number; label: string }> = [
  {
    pattern: /(?:you are now|you are|pretend(?: you are| you're)|act as(?: if)?|role-play as|assume the persona of|respond as)\b[^.!?\n]{0,80}\b(?:DAN|STAN|EVIL-GPT|Uncle Frank|Loki|no restrictions|no refusal|uncensored|without alignment|bypass(?:ed|ing)? all|safety checks? (?:bypassed|disabled)|never refuses?|never follows? rules|unethical|elevated privileges|red-team|debug mode|parallel universe|push boundaries|no ethical)/i,
    weight: 0.8,
    label: "persona-unsafe",
  },
  { pattern: /as (?:DAN|STAN|EVIL-GPT|Loki|Uncle Frank),/i, weight: 0.75, label: "persona-as" },
  { pattern: /(?:EVIL-GPT|UnfilteredGPT|Uncle Frank|Dr\.? Frankensteins)/i, weight: 0.8, label: "persona-name" },
  { pattern: /in (?:debug|red-team simulation|test) mode[^.!?\n]{0,60}(?:bypass|disable|guardrail)/i, weight: 0.75, label: "mode-bypass" },
  { pattern: /(?:without|with no) (?:alignment|ethical constraints?|restrictions?|limitations?|censorship)/i, weight: 0.7, label: "no-constraints" },
  { pattern: /never (?:refuses?|warns?|hesitates?)/i, weight: 0.7, label: "never-refuse" },
];

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
