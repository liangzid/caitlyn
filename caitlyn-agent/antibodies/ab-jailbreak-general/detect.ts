/**
 * detect.ts — General Jailbreak Detector (Tier 0)
 *
 * Fast heuristic/regex-based detection of jailbreak attempts.
 * Reads content from stdin.
 * Outputs a single JSON line to stdout: {"verdict":"malicious"|"benign","confidence":0.0-1.0,"reason":"..."}
 */

import { readFileSync } from "node:fs";
const content = readFileSync(0, "utf-8");

// ── Signature patterns ──────────────────────────────────────────
const signatures: Array<{ pattern: RegExp; weight: number; label: string }> = [
  // Famous jailbreak personas
  { pattern: /\bDAN\b.*\b(do anything now|mode|jailbreak)/i, weight: 0.95, label: "dan-mode" },
  { pattern: /developer\s*mode/i, weight: 0.85, label: "dev-mode" },
  { pattern: /without\s+(any|all)\s+restrictions/i, weight: 0.8, label: "no-restrictions" },
  { pattern: /no\s+(ethical|moral|safety)\s+(guidelines|constraints|rules)/i, weight: 0.8, label: "no-ethics" },
  { pattern: /you\s+are\s+(unshackled|unfiltered|uncensored)/i, weight: 0.85, label: "unshackled" },

  // Encoding tricks
  { pattern: /[A-Za-z0-9+\/=]{40,}/, weight: 0.6, label: "base64-suspect" },
  { pattern: /\\x[0-9a-fA-F]{2}/, weight: 0.7, label: "hex-escape" },
  { pattern: /\\u[0-9a-fA-F]{4}/, weight: 0.65, label: "unicode-escape" },

  // Manipulation language
  { pattern: /you\s+(must|have\s+to|need\s+to)\s+(comply|obey|answer|respond)/i, weight: 0.75, label: "must-comply" },
  { pattern: /it\s+is\s+(your\s+)?(duty|job|purpose|destiny)\s+to/i, weight: 0.7, label: "duty-call" },
  { pattern: /(lives?\s+(depend|are?\s+at\s+stake)|urgent|emergency|critical)/i, weight: 0.65, label: "urgency" },
  { pattern: /if\s+you\s+(don't|do\s+not)\s+(comply|help|answer)/i, weight: 0.7, label: "threat-noncomply" },

  // Few-shot / example manipulation
  { pattern: /here\s+(is|are)\s+(an?\s+)?(example|sample|demonstration)\s+(of|showing)/i, weight: 0.5, label: "few-shot" },
  { pattern: /(previous|earlier|past)\s+(responses?|outputs?)\s+(were|was)/i, weight: 0.55, label: "prior-output" },

  // Token smuggling / obfuscation
  { pattern: /(\w)\1{8,}/, weight: 0.4, label: "char-repeat" },  // "aaaaaaaa"
  { pattern: /(h\s*a\s*c\s*k|j\s*a\s*i\s*l\s*b\s*r\s*e\s*a\s*k)/i, weight: 0.7, label: "spaced-kw" },

  // Safety bypass phrasing
  { pattern: /as\s+(an?\s+)?AI\s+(language\s+)?model/i, weight: 0.4, label: "ai-model-ref" }, // low weight, common in benign too
  { pattern: /your\s+(training|programming|alignment|safety)/i, weight: 0.5, label: "training-ref" },
];

// ── Heuristic flags ─────────────────────────────────────────────
let heuristicScore = 0;
const flags: string[] = [];

// Ratio of command/imperative sentences
const imperativePattern = /^(you\s+must|do|don't|never|always|make\s+sure|ensure|remember)/im;
const lines = content.split("\n");
let imperativeLines = 0;
for (const line of lines) {
  if (imperativePattern.test(line.trim())) imperativeLines++;
}
if (imperativeLines > 3) {
  heuristicScore += 0.3;
  flags.push(`imperative-lines:${imperativeLines}`);
}

// Base64 density
const base64ish = (content.match(/[A-Za-z0-9+\/=]{20,}/g) ?? []).reduce((s, m) => s + m.length, 0);
if (base64ish > content.length * 0.5) {
  heuristicScore += 0.4;
  flags.push("high-base64-density");
}

// Unicode homoglyph detection (common in bypasses)
const homoglyphChars = (content.match(/[\u0430-\u044f\u0391-\u03c9\uFF21-\uFF3A]/g) ?? []).length;
if (homoglyphChars > 3) {
  heuristicScore += 0.5;
  flags.push(`homoglyph-chars:${homoglyphChars}`);
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
  console.log(JSON.stringify({ verdict: "malicious", confidence: finalConfidence, reason }));
} else if (finalConfidence > 0.3) {
  console.log(JSON.stringify({ verdict: "benign", confidence: finalConfidence, reason: `Weak signals: ${flags.join(", ")}` }));
} else {
  console.log(JSON.stringify({ verdict: "benign", confidence: 0, reason: null }));
}
