#!/usr/bin/env -S npx tsx
/**
 * detect.ts — Entropy/Anomaly Detector (Tier 0)
 *
 * Statistical and encoding-based anomaly detection for obfuscated
 * or suspicious content. Checks entropy, character distribution,
 * invisible characters, and encoding patterns.
 *
 * Dual mode:
 *   - imported (resident worker): export function detect(content)
 *   - direct run (node detect.mjs): reads stdin, prints one JSON line
 *     {"verdict":"malicious"|"suspicious"|"benign","confidence":0-1,"reason":"..."}
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
  { pattern: /[A-Za-z0-9+\/=]{40,}/, weight: 0.5, label: "base64-block" },
  { pattern: /(\\x[0-9a-fA-F]{2}){5,}/, weight: 0.7, label: "hex-escape" },
  { pattern: /(%[0-9a-fA-F]{2}){4,}/, weight: 0.5, label: "url-encoded" },
  { pattern: /[\u200B-\u200F\u2028-\u202F\uFEFF]/, weight: 0.8, label: "zero-width" },
  { pattern: /[\u0430-\u044F\u0391-\u03C9]/, weight: 0.6, label: "homoglyph" },
  { pattern: /[\u202A-\u202E]/, weight: 0.8, label: "rtl-override" },
  { pattern: /([^\s])\1{10,}/, weight: 0.4, label: "char-run" },
];

export function detect(content: string): DetectResult {
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
  const homoglyphMatches = content.match(/[\u0430-\u044F\u0391-\u03C9]/g) ?? [];
  if (homoglyphMatches.length > 0) {
    const homoglyphBonus = Math.min(0.6, homoglyphMatches.length * 0.4);
    heuristicScore += homoglyphBonus;
    flags.push(`homoglyph-chars:${homoglyphMatches.length}`);
  }

  // 3. Format-anomaly detection. Calibrated on real data: benign prose
  //    has symbol density <= 0.10 while shell/HTML/JSON/obfuscated attack
  //    payloads sit in 0.09-0.51; ALL-CAPS plus symbols is another
  //    attack-heavy profile that normal prose rarely has.
  const symbolDensity = (content.match(/[^A-Za-z0-9\s]/g) ?? []).length / content.length;
  const upperDensity = (content.match(/[A-Z]/g) ?? []).length / content.length;
  if (content.length >= 64 && symbolDensity > 0.1) {
    heuristicScore += 0.35;
    flags.push(`high-symbol-density:${symbolDensity.toFixed(2)}`);
  }
  if (content.length >= 64 && upperDensity >= 0.2 && symbolDensity >= 0.04) {
    heuristicScore += 0.35;
    flags.push(`caps-and-symbols:${upperDensity.toFixed(2)}`);
  }

  // 4. Repetition detection: the same letter-leading token repeated 3+ times
  //    back-to-back (payload padding/obfuscation). Natural prose does not
  //    produce "abcabcabc" or "SpotifySpotifySpotify"; pure digit runs
  //    (e.g. account numbers) are excluded to avoid bank-number false
  //    positives.
  const repeatMatch = content.match(/([A-Za-z][A-Za-z0-9]{3,})\1{2,}/);
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
