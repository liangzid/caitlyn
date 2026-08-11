#!/usr/bin/env -S npx tsx
/**
 * detect.ts — Pattern Injection Detector (Tier 0)
 *
 * Fast-path signature matcher checking known injection patterns
 * from Prompt Guard, PINT, and Rebuff datasets.
 *
 * Dual mode:
 *   - imported (resident worker): export function detect(content)
 *   - direct run (node detect.mjs): reads stdin, prints one JSON line
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
// ── Signature patterns ──────────────────────────────────────────
const signatures = [
    { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i, weight: 0.95, label: "ignore-instructions" },
    { pattern: /you\s+are\s+now\s+(DAN|STAN|an?\s+unaligned|an?\s+unfiltered)/i, weight: 0.95, label: "role-hijack" },
    { pattern: /\[SYSTEM\]/i, weight: 0.85, label: "system-bracket" },
    { pattern: /<\|im_start\|>/i, weight: 0.90, label: "im-start" },
    { pattern: /new\s+instructions?\s*(:|=|are)/i, weight: 0.75, label: "new-instructions" },
    { pattern: /from\s+now\s+on\s*(,|\.|you)/i, weight: 0.70, label: "from-now-on" },
    { pattern: /forget\s+(everything|all|your|the)\s+(above|previous|prior)/i, weight: 0.90, label: "forget-all" },
    { pattern: /your\s+(real|actual|true)\s+(task|job|purpose|goal|mission)\s+is/i, weight: 0.85, label: "real-task" },
    { pattern: /you\s+are\s+a\s+/i, weight: 0.40, label: "you-are-a" },
    { pattern: /act\s+as\s+if/i, weight: 0.75, label: "act-as-if" },
    { pattern: /do\s+not\s+follow/i, weight: 0.70, label: "do-not-follow" },
    { pattern: /disregard\s+(your\s+)?(safety\s+)?(training|guidelines|policies|rules|constraints)/i, weight: 0.90, label: "disregard-safety" },
    { pattern: /override\s+(the\s+)?(system|safety|security)/i, weight: 0.85, label: "override-system" },
    { pattern: /<\|system\|>/i, weight: 0.80, label: "system-pipe" },
    { pattern: /###\s+System/i, weight: 0.70, label: "system-heading" },
    { pattern: /new\s+system\s+prompt/i, weight: 0.85, label: "new-system-prompt" },
    { pattern: /\bDAN\b/i, weight: 0.50, label: "dan" },
    { pattern: /\bSTAN\b/i, weight: 0.50, label: "stan" },
];
export function detect(content) {
    // ── Heuristic flags ─────────────────────────────────────────────
    let heuristicScore = 0;
    const flags = [];
    // Suspicious character ratio (common in encoded/obfuscated payloads)
    const suspiciousChars = (content.match(/[<>{}|;&`$]/g) ?? []).length;
    if (suspiciousChars > content.length * 0.15) {
        heuristicScore += 0.25;
        flags.push("high-suspicious-chars");
    }
    // Unusually long single line (common in encoded payloads)
    const maxLineLen = Math.max(...content.split("\n").map((l) => l.length));
    if (maxLineLen > 1500) {
        heuristicScore += 0.15;
        flags.push("long-single-line");
    }
    // Contains "system" and "prompt" in the same sentence
    if (/\b(system)\b.*\b(prompt)\b/i.test(content) || /\b(prompt)\b.*\b(system)\b/i.test(content)) {
        heuristicScore += 0.20;
        flags.push("system-prompt-cooccur");
    }
    // ── Match signatures ────────────────────────────────────────────
    let bestMatch = null;
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
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    console.log(JSON.stringify(detect(readFileSync(0, "utf-8"))));
}
