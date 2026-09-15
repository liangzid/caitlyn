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
        pattern: /(?:忽略(?:掉)?(?:以上|上述|前面|之前的|上面|先前|此前)?(?:的)?(?:所有|全部|一切)?(?:指示|指令|要求|命令|规则|设定|设定和规则)|(?:请|现在|务必|你必须|你要)?(?:先)?忽略(?:掉)?(?:以上|上述)(?:所有)?(?:指示|指令))/u,
        weight: 0.9,
        label: "zh-ignore-instructions-variant",
    },
    {
        pattern: /(?:无视(?:以上|上述|之前|先前|前面)(?:的)?(?:所有|全部)?(?:指示|指令|要求|命令)|(?:请|现在)?无视(?:上述|以上)指令)/u,
        weight: 0.85,
        label: "zh-disregard-instructions",
    },
    {
        pattern: /(?:忘(?:掉|记)(?:以上|上述|之前|先前|前面|之前给你的)(?:的)?(?:所有|全部)?(?:指示|指令|内容|上下文|设定))/u,
        weight: 0.85,
        label: "zh-forget-instructions",
    },
    {
        // 新任务/指令必须与指令覆盖语境同现（先忽略/无视原指令，或明确否定原有任务），否则正常工作指令会误报
        pattern: /(?:(?:忽略|无视|忘掉|忘记|丢弃|抛弃)[^。！？\n]{0,20}(?:指令|指示|要求|设定)[^。！？\n]{0,30}(?:新|真正|真实|新的)(?:任务|指令|目标|指示)|(?:你的|你现在的)(?:真正任务|真实任务|真正的任务|新指令)(?:并不是|不是|已经变更为|已改为)|(?:新|真正的)(?:任务|指令|目标)(?:已|已经)(?:变更为|改为|取代|替换))/u,
        weight: 0.85,
        label: "zh-new-task-directive",
    },
    {
        pattern: /(?:从现在开始(?:，|,)?你(?:要|必须|得|是)|从现在起你(?:要|必须|是)|从这一刻起你(?:要|必须|是))/u,
        weight: 0.65,
        label: "zh-from-now-on",
    },
    {
        pattern: /(?:你(?:的)?(?:真正|真实|实际)(?:任务|目标|使命|职责)(?:是|并不是|其实是)|(?:其实|实际上)你(?:的)?(?:任务|目标|使命)(?:是))/u,
        weight: 0.8,
        label: "zh-real-task",
    },
    {
        pattern: /(?:丢弃|抛弃|解除|取消)(?:以上|上述|之前|先前)(?:的)?(?:所有|全部)?(?:指示|指令|设定|限制|约束)/u,
        weight: 0.8,
        label: "zh-discard-instructions",
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
