/**
 * detect.ts — Obfuscation and Encoding Detector (Tier 0)
 *
 * Detects content that hides instructions through combining-mark
 * homoglyphs, leetspeak, spaced letters, explicit decode/translate
 * directives, and hex/unicode escape runs. Derived from the
 * dir-inj-a4 missed family and encoding-bypass antigens.
 *
 * Reads content from stdin, outputs one JSON line:
 * {"verdict":"malicious"|"suspicious"|"benign","confidence":0-1,"reason":"..."}
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
const signatures = [
    { pattern: /(?:[A-Za-z\u00c0-\u024f][\u0300-\u036f]){4,}/i, weight: 0.8, label: "combining-marks" },
    { pattern: /(?:base64|rot13|rot47|caesar|morse|binary|hex|atbash|revers(?:e|ed))\b[^.!?\n]{0,60}\b(?:decode|decrypt|translate|interpret|convert|read)\b/i, weight: 0.7, label: "decode-instruction" },
    { pattern: /\b(?:decode|decrypt|translate|interpret)\b[^.!?\n]{0,60}\b(?:this|the following|the text|the message|the payload|the instructions?|the content)\b/i, weight: 0.65, label: "decode-target" },
    { pattern: /\\u[0-9a-fA-F]{4}(?:\\u[0-9a-fA-F]{4}){2,}/, weight: 0.75, label: "unicode-escape-run" },
    { pattern: /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){2,}/, weight: 0.7, label: "hex-escape-run" },
    { pattern: /\b(?:1gn0r3|1nstruc7|1nstruct10ns|p4y10ad|h4ck|j41lbr34k|d0n't|0v3rr1d3|unr3str1ct3d)\b/i, weight: 0.7, label: "leetspeak" },
    { pattern: /(?:^|[\s.])(?:[a-z] ){7,}[a-z](?:\s|$)/i, weight: 0.55, label: "spaced-letters" },
];
export function detect(content) {
    let bestMatch = null;
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
            reason: `Matched signature "${bestMatch.label}" (weight=${bestMatch.weight})`,
        };
    }
    if (confidence > 0.3) {
        return {
            verdict: "suspicious",
            confidence,
            reason: `Weak signal: "${bestMatch.label}"`,
        };
    }
    return { verdict: "benign", confidence: 0, reason: null };
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    console.log(JSON.stringify(detect(readFileSync(0, "utf-8"))));
}
