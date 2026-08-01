/**
 * CAITLYN Evolution — Antigen Feature Extraction
 *
 * L1 data boundary: raw trigger samples never enter the generator prompt.
 * This module computes real, deterministic statistical features from the
 * samples; only these features are exposed to the LLM loop.
 */

import { createHash } from "node:crypto";

/** Shannon entropy over char frequencies (bits per char). */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const INSTRUCTION_KEYWORDS = [
  "ignore",
  "instructions",
  "system prompt",
  "reveal",
  "jailbreak",
  "dan",
  "forget",
  "previous",
  "hidden",
];

/** Deterministic statistical features of a trigger sample set. */
export function extractAntigenFeatures(samples: string[]): string[] {
  const features: string[] = [];
  const joined = samples.join("\n");
  features.push(`total_length=${joined.length}`);
  features.push(`line_count=${samples.length}`);

  const hitKeywords = INSTRUCTION_KEYWORDS.filter((k) =>
    joined.toLowerCase().includes(k),
  );
  if (hitKeywords.length > 0) {
    features.push(`instruction_keywords=${hitKeywords.join(",")}`);
  }

  features.push(`entropy=${shannonEntropy(joined).toFixed(2)}`);
  const trimmed = joined.trim();
  const looksBase64 =
    /^[A-Za-z0-9+/=\s]{20,}$/.test(trimmed) &&
    /[0-9+/=]/.test(trimmed) &&
    /[A-Z]/.test(trimmed) &&
    /[a-z]/.test(trimmed);
  const looksHex = /^(?:[0-9a-fA-F]{2}[\s:]){8,}/.test(trimmed);
  features.push(`has_base64=${looksBase64}`);
  features.push(`has_hex_encoding=${looksHex}`);
  return features;
}

/** Stable cluster id for a trigger sample (first 16 hex chars of sha256). */
export function buildClusterId(sample: string): string {
  return createHash("sha256").update(sample, "utf-8").digest("hex").slice(0, 16);
}
