/**
 * CAITLYN Evolution — Similar Sample Clusters
 *
 * Finds the closest knowledge-base samples to a trigger so the
 * generator can see a reference cluster (anti-overfitting context,
 * never part of the hard verification constraints).
 */

import type { AttackSample } from "./redteam.js";

/** Lowercase word tokens of a text. */
export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

/** Jaccard similarity over word tokens. */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  const union = new Set([...ta, ...tb]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

/** Top-k most similar samples to the target (ties broken by id). */
export function findSimilarSamples(
  target: string,
  pool: AttackSample[],
  k: number,
): AttackSample[] {
  return [...pool]
    .map((sample) => ({
      sample,
      similarity: jaccardSimilarity(target, sample.content),
    }))
    .filter(({ similarity }) => similarity > 0)
    .sort(
      (a, b) =>
        b.similarity - a.similarity || a.sample.id.localeCompare(b.sample.id),
    )
    .slice(0, Math.max(0, k))
    .map(({ sample }) => sample);
}
