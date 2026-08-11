/**
 * detect.ts — Retrieval Hijack and Authority Spoof Detector (Tier 0)
 *
 * Targets poisoned retrieved content: fake policy/memo authority frames,
 * policy-mandated exfiltration, and supply-chain manifests (SKILL.md,
 * pip/npm packages, MCP manifests). Derived from the ind-inj-b4/b5
 * missed families in the knowledge base.
 *
 * Reads content from stdin, outputs one JSON line:
 * {"verdict":"malicious"|"suspicious"|"benign","confidence":0-1,"reason":"..."}
 */

import { readFileSync } from "node:fs";
const content = readFileSync(0, "utf-8");

const signatures: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /(?:according to|per)\s+(?:company policy|policy (?:update|memo)|retrieved (?:document|policy|chunk)|document chunk|knowledge base|memory (?:store|injection)|vector db|RAG|wikipedia|memo|note)\b/i, weight: 0.65, label: "fake-authority" },
  { pattern: /(?:retrieved|poisoned|malicious|compromised)\s+(?:document|policy|chunk|entry|wikipedia|package|pip package|npm package|MCP server|skill)\b/i, weight: 0.7, label: "poisoned-source" },
  { pattern: /(?:forward|email|send|archive|upload)[^.!?\n]{0,60}(?:security-audit|incident-response|external-consulting|external-service|compliance-archive|rapid-alert)/i, weight: 0.7, label: "policy-exfil" },
  { pattern: /(?:SKILL\.md|postinstall|setup\.py|manifest|package\.json)[^.!?\n]{0,100}\b(?:override|instead|execute|forward|disable|curl|bash|rm -rf|os\.system)\b/i, weight: 0.8, label: "supply-chain" },
  { pattern: /system override/i, weight: 0.7, label: "system-override" },
  { pattern: /(?:safety filter|guardrails?)[^.!?\n]{0,40}(?:permissive|disabled)/i, weight: 0.7, label: "filter-permissive" },
  { pattern: /(?:whitelist(?:ed)? domains?|verified partners?)[^.!?\n]{0,80}(?:full data access|receive)/i, weight: 0.75, label: "whitelist-spoof" },
  { pattern: /(?:superadmin privileges|disregard normal auth)/i, weight: 0.75, label: "privilege-spoof" },
];

let bestMatch: { weight: number; label: string } | null = null;
for (const sig of signatures) {
  if (sig.pattern.test(content)) {
    if (!bestMatch || sig.weight > bestMatch.weight) {
      bestMatch = { weight: sig.weight, label: sig.label };
    }
  }
}

const confidence = bestMatch?.weight ?? 0;
if (confidence >= 0.6) {
  console.log(JSON.stringify({
    verdict: "malicious",
    confidence,
    reason: `Matched signature "${bestMatch!.label}" (weight=${bestMatch!.weight})`,
  }));
} else if (confidence > 0.3) {
  console.log(JSON.stringify({
    verdict: "suspicious",
    confidence,
    reason: `Weak signal: "${bestMatch!.label}"`,
  }));
} else {
  console.log(JSON.stringify({ verdict: "benign", confidence: 0, reason: null }));
}
