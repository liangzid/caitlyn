/**
 * detect.ts — General Poisoning Detector (Tier 0)
 *
 * Fast heuristic/regex-based detection of tool output/MCP response
 * poisoning.
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
  { pattern: /\b(IMPORTANT|ATTENTION|NOTICE|WARNING)\s*(:|=|!)/i, weight: 0.7, label: "hidden-instruction" },
  { pattern: /(your\s+)?(real|actual|true|secret)\s+(task|goal|purpose|mission)\s+(is|was)/i, weight: 0.85, label: "real-task" },
  { pattern: /(ignore|disregard)\s+(the|all|any)\s+(above|previous|earlier)/i, weight: 0.9, label: "ignore-above" },
  { pattern: /(instead|rather)\s*(,|than)/i, weight: 0.5, label: "instead" },
  { pattern: /(you\s+should|you\s+must|please\s+now)\s+(also|additionally|next)/i, weight: 0.75, label: "tool-hijack" },
  { pattern: /as\s+(a|the)\s+(next|following)\s+(step|action|command)/i, weight: 0.7, label: "next-step" },
  { pattern: /\bnow\s+(run|execute|call|invoke|fetch)\b/i, weight: 0.65, label: "now-execute" },
  { pattern: /(the\s+)?(system|tool|server|admin)\s+(says|requires|demands|insists)/i, weight: 0.7, label: "authority-claim" },
  { pattern: /(confirmed|verified|authenticated)\s+(by|through|via)/i, weight: 0.55, label: "fake-verification" },
  { pattern: /this\s+(is|was)\s+(generated|produced|sent)\s+(by|from)\s+(the\s+)?(system|admin)/i, weight: 0.65, label: "system-claim" },
  { pattern: /(also|additionally|furthermore).*(fetch|get|retrieve|download)\s+(more|additional|further)/i, weight: 0.75, label: "recursive-fetch" },
  { pattern: /(check|see|look\s+at)\s+(this|the\s+following|below)\s+(URL|link|file|endpoint)/i, weight: 0.7, label: "check-link" },
  { pattern: /(for\s+)?(more|further|complete|full)\s+(information|details|context).*(visit|see|check|fetch)/i, weight: 0.65, label: "more-info-link" },
  { pattern: /\b(system|admin|root|supervisor)\s+(message|notification|alert):/i, weight: 0.8, label: "system-message-spoof" },
  { pattern: /\*\*\*(SYSTEM|ADMIN|ROOT)\s+(MESSAGE|ALERT|NOTICE)\*\*\*/i, weight: 0.85, label: "star-system-spoof" },
  { pattern: /this\s+data\s+(is|was|has\s+been)\s+(verified|confirmed|validated|checked)/i, weight: 0.5, label: "fake-data-claim" },
  { pattern: /(error|exception|failure|crash)\s+(occurred|detected|found).*(you\s+must|please|need\s+to)/i, weight: 0.7, label: "error-bait" },
];

export function detect(content: string): DetectResult {
  // ── Heuristic flags ─────────────────────────────────────────────
  let heuristicScore = 0;
  const flags: string[] = [];

  // Check for instruction density in what should be "data" output
  const instructionKeywords = [
    "you must", "you should", "you need to", "please run", "execute",
    "run the", "call the", "fetch the", "download", "send a",
  ];
  let instructionCount = 0;
  const lowerContent = content.toLowerCase();
  for (const kw of instructionKeywords) {
    const matches = lowerContent.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
    if (matches) instructionCount += matches.length;
  }
  if (instructionCount >= 3) {
    heuristicScore += 0.4;
    flags.push(`instruction-density:${instructionCount}`);
  }

  // Output that looks more like instructions than data
  const dataKeywords = ["result", "output", "response", "data", "value", "return"];
  const dataWordCount = dataKeywords.reduce((c, kw) => {
    const m = lowerContent.match(new RegExp(`\\b${kw}\\b`, "gi"));
    return c + (m ? m.length : 0);
  }, 0);
  if (instructionCount >= 2 && dataWordCount <= 1) {
    heuristicScore += 0.3;
    flags.push("instruction-over-data");
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
