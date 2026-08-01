/**
 * CAITLYN Evolution — CLI Commands
 *
 * Explicit trigger channel: `caitlyn vaccinate <pattern>` runs the
 * immune System 2 loop; `--approve <id>` and `--status` manage the DAG.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import {
  loadConfig,
  loadEvolutionConfig,
  type EvolutionConfig,
} from "../config.js";
import { getCredentialEnv } from "../config/credentials.js";
import { resolveModel } from "../llm.js";
import type { LlmCallFn } from "../scanner.js";
import { AntibodyDagStore } from "../evolution/dag-store.js";
import { dagPolicyFrom, EvolutionEngine } from "../evolution/engine.js";
import { buildClusterId, extractAntigenFeatures } from "../evolution/features.js";
import { loadAttackSamples, runRedTeam } from "../evolution/redteam.js";
import { ShadowManager } from "../evolution/shadow.js";
import { loadHistory } from "../history.js";
import { loadAntibodies } from "../library.js";

/** Build an LLM call bound to a specific model (generator or reviewer). */
export function makeModelLlmCall(model: Model<any>): LlmCallFn {
  const credentialEnv = getCredentialEnv(model.provider ?? "");
  return async (systemPrompt: string, userPrompt: string) => {
    const ctx = {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    };
    const response = await complete(model, ctx, credentialEnv ? { env: credentialEnv } : undefined);
    const textBlocks = response.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    return textBlocks.map((c) => c.text).join("");
  };
}

/** Resolve generator (model) and reviewer (small_model) call functions. */
export function makeEvolutionLlmPair(): {
  generator: LlmCallFn;
  reviewer: LlmCallFn;
} {
  const config = loadConfig();
  const evolution = loadEvolutionConfig();
  const generatorModel = resolveModel({
    provider: config.provider,
    model: evolution.generatorModel ?? config.model,
    smallModel: config.smallModel,
  });
  const reviewerModel = resolveModel({
    provider: config.provider,
    model: evolution.reviewerModel ?? config.smallModel,
    smallModel: config.smallModel,
  });
  return {
    generator: makeModelLlmCall(generatorModel),
    reviewer: makeModelLlmCall(reviewerModel),
  };
}

/** `caitlyn vaccinate <pattern>` — explicit immune response. */
export async function runVaccination(pattern: string): Promise<void> {
  const config = loadEvolutionConfig();
  const { generator, reviewer } = makeEvolutionLlmPair();
  const clusterId = buildClusterId(pattern);
  const benign = loadHistory()
    .filter((h) => h.verdict === "benign")
    .slice(0, config.benignSamples)
    .map((h) => h.content_preview);

  const engine = new EvolutionEngine({ config, generatorLlm: generator, reviewerLlm: reviewer });
  const outcome = await engine.run({
    clusterId,
    target: `user-requested vaccination for cluster ${clusterId}`,
    profile: {
      clusterId,
      category: "unknown",
      features: extractAntigenFeatures([pattern]),
      sampleCount: 1,
    },
    mustDetect: [pattern],
    benign,
    hasSamples: true,
  });

  const { loop } = outcome;
  console.log(`Round(s): ${loop.rounds} | Tokens: ~${loop.tokensUsed}`);
  console.log(`Termination: ${loop.termination} | Lessons written: ${loop.lessonsWritten}`);
  if (loop.approved.length === 0) {
    console.log("No antibody accepted this run.");
    return;
  }
  for (const vc of loop.approved) {
    console.log(
      `✅ ${vc.draft.id}: ${vc.draft.name} (${vc.draft.signatures.length} signatures)`,
    );
  }
  if (outcome.shadowStarted.length > 0) {
    console.log(`👁️  Shadow observation started: ${outcome.shadowStarted.join(", ")}`);
  }
}

/** `caitlyn vaccinate --approve <id>` — explicit approval channel. */
export function approveAntibody(id: string, configOverride?: EvolutionConfig): void {
  const config = configOverride ?? loadEvolutionConfig();
  const dag = new AntibodyDagStore(config.evolutionDir, dagPolicyFrom(config));
  dag.load();
  const manager = new ShadowManager(dag, {
    shadowWindowDays: config.shadowWindowDays,
    shadowMinScans: config.shadowMinScans,
  });
  if (!manager.approve(id)) {
    console.log(`Cannot approve ${id}: not found or already active/archived.`);
    return;
  }
  dag.save();
  console.log(`✅ ${id} approved and activated.`);
}

/** `caitlyn vaccinate --status` — DAG overview. */
export function printEvolutionStatus(configOverride?: EvolutionConfig): void {
  const config = configOverride ?? loadEvolutionConfig();
  const dag = new AntibodyDagStore(config.evolutionDir, dagPolicyFrom(config));
  dag.load();
  const nodes = dag.listNodes();
  if (nodes.length === 0) {
    console.log("Evolution DAG is empty.");
    return;
  }
  console.log(`Evolution DAG: ${nodes.length} nodes (dir: ${config.evolutionDir})`);
  for (const node of nodes) {
    console.log(
      `  ${node.id} [${node.status}] tier${node.tier} ` +
        `score=${dag.computeScore(node).toFixed(2)} hits=${node.evidence.hits}`,
    );
  }
}

/** `caitlyn vaccinate --redteam [category]` — active red-team drill. */
export async function runRedTeamCommand(categoryFilter?: string): Promise<void> {
  const allSamples = loadAttackSamples();
  const samples = categoryFilter
    ? allSamples.filter((s) => s.category === categoryFilter)
    : allSamples;
  if (samples.length === 0) {
    console.log(
      categoryFilter
        ? `No attack samples for category "${categoryFilter}".`
        : "No attack samples found.",
    );
    return;
  }
  console.log(
    `🛡️  Red-team drill: ${samples.length} real attack samples ` +
    `(category: ${categoryFilter ?? "all"})`,
  );
  const report = await runRedTeam(samples, loadAntibodies());
  console.log(`Detection rate: ${(report.detectionRate * 100).toFixed(1)}% (${report.detected}/${report.total})`);
  for (const c of report.byCategory) {
    console.log(
      `  ${c.category}: ${c.detected}/${c.total} ` +
      `(${(c.detectionRate * 100).toFixed(1)}%)`,
    );
  }
  if (report.missedSampleIds.length > 0) {
    console.log(`Missed: ${report.missedSampleIds.join(", ")}${report.truncated ? ", …" : ""}`);
  }
}
