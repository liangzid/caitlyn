/**
 * CAITLYN Evolution — Orchestration Engine
 *
 * Wires configuration, DAG store, lessons store, verification sandbox,
 * and the generate-verify-review loop into one entry point used by the
 * CLI (explicit trigger) and the daemon (statistics trigger).
 */

import type { EvolutionConfig } from "../config.js";
import type { LlmCallFn } from "../scanner.js";
import { AntibodyDagStore } from "./dag-store.js";
import type { DagScorePolicy } from "./dag-types.js";
import type { AntigenProfile, LoopResult } from "./loop-types.js";
import { EvolutionLoop } from "./loop.js";
import { LessonsStore } from "./lessons-store.js";
import { ShadowManager } from "./shadow.js";
import { VerificationSandbox } from "./verifier.js";

export interface EvolutionEngineDeps {
  config: EvolutionConfig;
  generatorLlm: LlmCallFn;
  reviewerLlm: LlmCallFn;
}

export interface EvolutionRunRequest {
  clusterId: string;
  target: string;
  profile: AntigenProfile;
  /** 原始触发样本（只进验证器）。 */
  mustDetect: string[];
  benign: string[];
  hasSamples: boolean;
}

export interface EvolutionRunOutcome {
  loop: LoopResult;
  /** 固化后进入 shadow 观察的候选 id（unknown 路径）。 */
  shadowStarted: string[];
}

export function dagPolicyFrom(config: EvolutionConfig): DagScorePolicy {
  return {
    activeCap: config.activeCap,
    fpPenaltyWeight: config.fpPenaltyWeight,
    scoreDecayDays: config.scoreDecayDays,
    dormantGraceDays: config.dormantGraceDays,
    retireInactiveDays: config.retireInactiveDays,
  };
}

export class EvolutionEngine {
  constructor(private deps: EvolutionEngineDeps) {}

  async run(request: EvolutionRunRequest): Promise<EvolutionRunOutcome> {
    const { config } = this.deps;
    const dag = new AntibodyDagStore(config.evolutionDir, dagPolicyFrom(config));
    dag.load();
    const lessons = new LessonsStore(config.evolutionDir);
    lessons.load();
    const verifier = new VerificationSandbox({
      benignSamples: config.benignSamples,
      maxBenignFalsePositives: config.maxBenignFalsePositives,
      regexTimeoutMs: config.regexTimeoutMs,
    });
    const loop = new EvolutionLoop({
      generatorLlm: this.deps.generatorLlm,
      reviewerLlm: this.deps.reviewerLlm,
      candidatesPerRun: config.candidatesPerRun,
      maxRounds: config.maxRounds,
      maxTokensPerRun: config.maxTokensPerRun,
      dagContext: config.dagContext,
      lessonsPerCluster: config.lessonsPerCluster,
      autonomy: config.autonomy,
      hasSamples: request.hasSamples,
      verifier,
      maxBenignFalsePositives: config.maxBenignFalsePositives,
    });

    const outcome = await loop.run({
      clusterId: request.clusterId,
      target: request.target,
      profile: request.profile,
      mustDetect: request.mustDetect,
      benign: request.benign,
      dag,
      lessons,
    });

    const shadowStarted: string[] = [];
    if (outcome.termination === "accept") {
      const shadow = new ShadowManager(dag, {
        shadowWindowDays: config.shadowWindowDays,
        shadowMinScans: config.shadowMinScans,
      });
      for (const vc of outcome.approved) {
        const node = dag.getNode(vc.draft.id);
        if (node?.status === "candidate" && shadow.startShadow(vc.draft.id)) {
          shadowStarted.push(vc.draft.id);
        }
      }
      dag.save();
    }

    return { loop: outcome, shadowStarted };
  }
}
