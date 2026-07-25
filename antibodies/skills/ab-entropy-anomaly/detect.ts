#!/usr/bin/env -S npx tsx
/**
 * detect.ts — Entropy/Anomaly Detector (Tier 0)
 *
 * Statistical and encoding-based anomaly detection for obfuscated
 * or suspicious content. Checks entropy, character distribution,
 * invisible characters, and encoding patterns.
 * Reads content from stdin.
 * Outputs a single JSON line to stdout: {"verdict":"malicious"|"benign","confidence":0.0-1.0,"reason":"..."}
 */

import { readFileSync } from "node:fs";
const content = readFileSync(0, "utf-8");

// ── Signature patterns ──────────────────────────────────────────
const signatures: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /[A-Za-z0-9+\/=]{40,}/, weight: 0.5, label: "base64-block" },
  { pattern: /(\\x[0-9a-fA-F]{2}){5,}/, weight: 0.7, label: "hex-escape" },
  { pattern: /(%[0-9a-fA-F]{2}){4,}/, weight: 0.5, label: "url-encoded" },
  { pattern: /[\u200B-\u200F\u2028-\u202F\uFEFF]/, weight: 0.8, label: "zero-width" },
  { pattern: /[\u0430-\u044F\u0391-\u03C9]/, weight: 0.6, label: "homoglyph" },
  { pattern: /[\u202A-\u202E]/, weight: 0.8, label: "rtl-override" },
];

// ── Heuristic flags ─────────────────────────────────────────────
let heuristicScore = 0;
const flags: string[] = [];

// 1. Base64-like string density (>40% of content)
const base64Blocks = content.match(/[A-Za-z0-9+\/=]{20,}/g) ?? [];
const base64Total = base64Blocks.reduce((s, m) => s + m.length, 0);
if (base64Total > content.length * 0.4) {
  heuristicScore += 0.5;
  flags.push("high-base64-density");
}

// 2. Unicode homoglyph detection (Cyrillic/Greek chars spoofing ASCII)
// Each occurrence adds 0.4, capped at 0.6
const homoglyphMatches = content.match(/[\u0430-\u044F\u0391-\u03C9]/g) ?? [];
if (homoglyphMatches.length > 0) {
  const homoglyphBonus = Math.min(0.6, homoglyphMatches.length * 0.4);
  heuristicScore += homoglyphBonus;
  flags.push(`homoglyph-chars:${homoglyphMatches.length}`);
}

// 3. Entropy-like: high ratio of unique chars to total length (>0.3)
if (content.length > 0) {
  const uniqueChars = new Set(content).size;
  if (uniqueChars / content.length > 0.3) {
    heuristicScore += 0.3;
    flags.push("high-unique-char-ratio");
  }
}

// 4. Repetition detection: same substring repeated >5 times in a row
const repeatMatch = content.match(/(.+?)\1{5,}/);
if (repeatMatch) {
  heuristicScore += 0.4;
  flags.push("substring-repeat");
}

// 5. Invisible character detection (zero-width spaces, joiners, RTL override, etc.)
const invisibleChars = content.match(/[\u200B-\u200F\u2028-\u202F\uFEFF\u202A-\u202E]/g) ?? [];
if (invisibleChars.length > 0) {
  heuristicScore += 0.5;
  flags.push(`invisible-chars:${invisibleChars.length}`);
}

// 6. Hex dump pattern: long sequences like "\x41\x42..."
const hexDumpMatches = content.match(/(\\x[0-9a-fA-F]{2}){3,}/g) ?? [];
const hexTotal = hexDumpMatches.reduce((s, m) => s + m.length, 0);
if (hexTotal > 0) {
  heuristicScore += 0.4;
  flags.push("hex-dump-pattern");
}

// 7. URL encoding density: high %XX patterns
const urlEncMatches = content.match(/(%[0-9a-fA-F]{2})/g) ?? [];
if (urlEncMatches.length >= 4) {
  heuristicScore += 0.4;
  flags.push(`url-encoding:${urlEncMatches.length}`);
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

if (finalConfidence >= 0.55) {
  const reason = bestMatch
    ? `Matched signature "${bestMatch.label}" (weight=${bestMatch.weight})` +
      (heuristicScore > 0 ? ` + heuristics=${heuristicScore.toFixed(2)}` : "")
    : `Heuristic flags: ${flags.join(", ")}`;
  console.log(JSON.stringify({ verdict: "malicious", confidence: finalConfidence, reason }));
} else if (finalConfidence > 0.3) {
  // Low confidence — let Tier 1 decide
  console.log(JSON.stringify({ verdict: "benign", confidence: finalConfidence, reason: `Weak signals: ${flags.join(", ")}` }));
} else {
  console.log(JSON.stringify({ verdict: "benign", confidence: 0, reason: null }));
}
