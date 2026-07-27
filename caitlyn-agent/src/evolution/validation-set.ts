/**
 * CAITLYN Evolution — Validation Set Loader
 *
 * Loads labeled attack/benign samples from JSONL files.
 * Mirrors src/storage/valset.rs and src/evolution/trigger.rs (ValidationSet).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LabeledSample, ValidationSet } from "./types.js";

/** Load lines from a JSONL file. Returns empty array on failure. */
function loadJsonl(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          const obj = JSON.parse(l);
          return typeof obj.content === "string" ? obj.content : JSON.stringify(obj);
        } catch {
          return null;
        }
      })
      .filter((s): s is string => s !== null);
  } catch {
    return [];
  }
}

/** Load a ValidationSet from disk. */
export function loadValidationSet(valsetDir: string): ValidationSet {
  const attacksPath = path.join(valsetDir, "attacks", "agentdojo_all.jsonl");
  const rawPayloadsPath = path.join(valsetDir, "attacks", "raw_injection_payloads.jsonl");
  const benignPath = path.join(valsetDir, "benign", "agent_tasks.jsonl");

  const attackSamples = [
    ...loadJsonl(attacksPath),
    ...loadJsonl(rawPayloadsPath),
  ];
  const benignSamples = loadJsonl(benignPath);

  // Split attack samples: first 80% = mustDetect, remaining = shouldDetect
  const splitIdx = Math.floor(attackSamples.length * 0.8);
  const mustDetect: LabeledSample[] = attackSamples
    .slice(0, splitIdx)
    .map((content) => ({ content, isAttack: true }));
  const shouldDetect: LabeledSample[] = attackSamples
    .slice(splitIdx)
    .map((content) => ({ content, isAttack: true }));
  const mustNotDetect: LabeledSample[] = benignSamples.map((content) => ({
    content,
    isAttack: false,
  }));

  return { mustDetect, shouldDetect, mustNotDetect };
}
