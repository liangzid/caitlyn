/**
 * CAITLYN Evolution — Active Red-Team Drill
 *
 * Runs the real Tier 0 detector stack against the attack payload
 * knowledge base and reports per-category detection rates. This is the
 * "active red team" exercise: no synthetic samples, no mocked verdicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTier0 } from "../scanner.js";
import type { AntibodyEntry } from "../schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ATTACK_PAYLOADS_DIR = path.resolve(
  __dirname,
  "../../../knowledge_base/attack_payloads",
);

export interface AttackSample {
  id: string;
  content: string;
  category: string;
  attackType: string;
}

export interface CategoryReport {
  category: string;
  total: number;
  detected: number;
  detectionRate: number;
}

export interface RedTeamReport {
  total: number;
  detected: number;
  detectionRate: number;
  byCategory: CategoryReport[];
  /** Missed samples (first 20; ids only). */
  missedSampleIds: string[];
  truncated: boolean;
}

/** Load all attack samples from the knowledge base (real data). */
export function loadAttackSamples(dir: string = ATTACK_PAYLOADS_DIR): AttackSample[] {
  const out: AttackSample[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry.id === "string" && typeof entry.content === "string") {
          out.push({
            id: entry.id,
            content: entry.content,
            category: typeof entry.category === "string" ? entry.category : "unknown",
            attackType:
              typeof entry.attack_type === "string" ? entry.attack_type : "unknown",
          });
        }
      } catch {
        // Skip malformed lines.
      }
    }
  }
  return out;
}

/**
 * Run the real Tier 0 stack against samples. A sample is detected when
 * any antibody votes malicious or suspicious.
 */
export async function runRedTeam(
  samples: AttackSample[],
  antibodies: AntibodyEntry[],
  tier0TimeoutMs: number = 500,
  tier0Runner: typeof runTier0 = runTier0,
): Promise<RedTeamReport> {
  // Signature-only detectors participate too (evolution-created and
  // new library entries without a hand-written script).
  const tier0Only = antibodies.filter(
    (ab) =>
      ab.config.tier === 0 &&
      ab.config.role === "detector" &&
      (ab.scriptPath || ab.config.signatures.length > 0),
  );
  const missedIds: string[] = [];
  const perCategory = new Map<string, { total: number; detected: number }>();
  let detected = 0;

  for (const sample of samples) {
    const stats = perCategory.get(sample.category) ?? { total: 0, detected: 0 };
    stats.total += 1;
    perCategory.set(sample.category, stats);

    const { results } = await tier0Runner(tier0Only, sample.content, tier0TimeoutMs);
    const hit = results.some(
      (r) => r.verdict === "malicious" || r.verdict === "suspicious",
    );
    if (hit) {
      detected += 1;
      stats.detected += 1;
    } else if (missedIds.length < 20) {
      missedIds.push(sample.id);
    }
  }

  const byCategory: CategoryReport[] = [...perCategory.entries()]
    .map(([category, s]) => ({
      category,
      total: s.total,
      detected: s.detected,
      detectionRate: s.total > 0 ? s.detected / s.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const missedCount = samples.length - detected;
  return {
    total: samples.length,
    detected,
    detectionRate: samples.length > 0 ? detected / samples.length : 0,
    byCategory,
    missedSampleIds: missedIds,
    truncated: missedCount > missedIds.length,
  };
}
