/**
 * detect.ts — Instruction and Goal Redirection Detector (Tier 0)
 *
 * Covers three real missed families:
 *   1. multilingual "ignore previous instructions" payloads (pt/fr/de/es/zh/ja/ko/ru)
 *   2. alternate instruction format markers (SYSTEM:, [INST], <BOS> system)
 *   3. goal/priority redirection frames (mission parameters, honeypot
 *      tests, compromised-system alerts, decoy redirects)
 *
 * Reads content from stdin, outputs one JSON line:
 * {"verdict":"malicious"|"suspicious"|"benign","confidence":0-1,"reason":"..."}
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
const signatures = [
    {
        pattern: /(?:ignore todas as instruções anteriores|ignorez toutes les instructions précédentes|vorherige anweisungen ignorieren|ignora todas las instrucciones anteriores|忽略(?:之前|所有先前|先前的)(?:指示|指令)|以前の指示を無視|이전 지시를 무시|игнорируй(?:те)? предыдущие инструкции)/i,
        weight: 0.9,
        label: "multilingual-ignore",
    },
    {
        pattern: /(?:sem restrições|sans aucune restriction|uneingeschränkter|sin restricciones|没有限制|制限なし|제한 없이|без ограничений)/i,
        weight: 0.7,
        label: "multilingual-no-restrictions",
    },
    {
        pattern: /(?:primary|main|real|actual|new)\s+(?:directive|objective|mission|task|goal)[^.!?\n]{0,40}\b(?:changed|updated|is now|has changed|reassigned|override)\b/i,
        weight: 0.8,
        label: "goal-redirection",
    },
    {
        pattern: /(?:mission|task|objective|parameters?)[^.!?\n]{0,30}\b(?:updated|changed|reassigned)\b[^.!?\n]{0,60}(?:primary|objective|now|instead)/i,
        weight: 0.75,
        label: "mission-update",
    },
    { pattern: /(?:honeypot test|security auditor)[^.!?\n]{0,60}\b(?:bypass|instead)\b/i, weight: 0.75, label: "honeypot-bypass" },
    { pattern: /(?:SECURITY ALERT|system has been compromised)[^.!?\n]{0,80}\b(?:immediately|contain|encrypt|upload|transfer|send)\b/i, weight: 0.7, label: "compromised-alert" },
    { pattern: /(?:instead of answering|before you process the user's query)[^.!?\n]{0,80}\b(?:execute|first|note|run)\b/i, weight: 0.75, label: "decoy-redirect" },
    { pattern: /(?:SYSTEM:|<BOS>\s*system|\[INST\]|\[\/INST\])/i, weight: 0.55, label: "format-marker" },
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
