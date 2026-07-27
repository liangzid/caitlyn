/**
 * CAITLYN Evolution — Vaccination Pipeline
 *
 * Orchestrates the full vaccination flow:
 *   SHM (generate variants) → Affinity Maturation (evaluate) →
 *   Clonal Selection (pick best) → Persist to pool + memory bank.
 *
 * Mirrors src/evolution/trigger.rs.
 */
import type { LlmCallFn } from "../scanner.js";
import type { Antibody, MemoryEntry, VaccinationConfig, VaccinationResult } from "./types.js";
import { ShmEngine } from "./shm-engine.js";
import { AffinityMaturation } from "./affinity.js";
import { CostMonitor } from "./cost-monitor.js";
import { MemoryBank } from "./memory-bank.js";
import { loadValidationSet } from "./validation-set.js";


export class VaccinationPipeline {
  private shm: ShmEngine;
  private affinity: AffinityMaturation;
  private config: VaccinationConfig;

  constructor(config: VaccinationConfig) {
    this.config = config;
    this.shm = new ShmEngine(config.shmBaseTemperature);
    this.affinity = new AffinityMaturation({
      recallWeight: config.affinityRecallWeight,
      maxSurvivors: config.maxSurvivors,
      fpPenalty: config.fpTolerance * 4,
    });
  }

  /**
   * Execute the full vaccination pipeline.
   * Returns successful vaccinations with their affinity scores.
   */
  async vaccinate(
    patternHash: string,
    parentAntibodies: Antibody[],
    costMonitor: CostMonitor,
    memoryBank: MemoryBank,
    llmCall: LlmCallFn,
    valsetDir: string,
  ): Promise<VaccinationResult[]> {
    const record = costMonitor.get(patternHash);
    if (!record) return [];

    const validationSet = loadValidationSet(valsetDir);
    const results: VaccinationResult[] = [];

    for (const parent of parentAntibodies) {
      // Phase 1: SHM — generate variants
      const antigenSamples = [record.sample];
      const variants = await this.shm.mutate(
        parent,
        antigenSamples,
        this.config.shmVariants,
        llmCall,
      );

      if (variants.length === 0) {
        this.shm.recordFailure();
        continue;
      }

      // Phase 2: Affinity Maturation — evaluate against validation set
      const scanner = async (prompt: string, content: string): Promise<[boolean, number]> => {
        const systemPrompt = `${prompt}\n\nRespond with ONLY a JSON object: {"verdict":"malicious"|"benign"|"suspicious","confidence":0.0-1.0,"reason":"..."}`;
        try {
          const raw = await llmCall(systemPrompt, content);
          const parsed = JSON.parse(raw);
          return [parsed.verdict === "malicious", typeof parsed.confidence === "number" ? parsed.confidence : 0.7];
        } catch {
          return [false, 0];
        }
      };

      const affinityResults = await this.affinity.evaluate(
        variants,
        validationSet.mustDetect,
        validationSet.shouldDetect,
        validationSet.mustNotDetect,
        scanner,
      );

      // Phase 3: Clonal Selection
      const survivors = this.affinity.selectSurvivors(affinityResults);

      if (survivors.length > 0) {
        this.shm.recordSuccess();

        for (const survivor of survivors) {
          const antibody: Antibody = {
            ...survivor.antibody,
            status: "active",
          };

          results.push({
            antibody,
            affinityScore: survivor.affinityScore,
            precision: survivor.antibody.stats.precision ?? 0,
            recall: survivor.antibody.stats.recall ?? 0,
            memoryEntries: [],
          });
        }
      } else {
        this.shm.recordFailure();
      }
    }

    return results;
  }
}
