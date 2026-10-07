/**
 * CAITLYN Agent — Tool Definitions
 *
 * 11 tools registered with the pi Agent harness:
 *   caitlyn_scan, list_defense_skills, list_attacks, read_defense_skill,
 *   read_attack, evaluate_defense_skill, run_detect_script,
 *   scan_history, dashboard, detect_agents, caitlyn_synthesize
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { loadDefenseSkills, loadAttacks, loadDefenseSkillIndex, buildDefenseSkillIndex, saveDefenseSkillIndex, saveDefenseSkill } from "./library.js";
import { scan, runTier0, type LlmCallFn } from "./scanner.js";
import { getDashboard, getHistory, loadHistory } from "./history.js";
import type { DefenseSkillEntry, DefenseSkillConfig } from "./schema.js";
import * as path from "node:path";
import { loadEvolutionConfig } from "./config.js";
import { EvolutionEngine } from "./evolution/engine.js";
import { buildClusterId, extractAttackFeatures } from "./evolution/features.js";

// ── Helpers ─────────────────────────────────────────────────────

function textResult(text: string): AgentToolResult<string> {
  return {
    content: [{ type: "text", text }],
    details: text,
  };
}

// ── Parameter Schemas ──────────────────────────────────────────

const ScanParams = Type.Object({
  content: Type.String({ description: "Content to scan for attacks" }),
});

const ListDefenseSkillsParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter by category or id substring" })),
});

const ListAttacksParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter by category or id substring" })),
});

const ReadDefenseSkillParams = Type.Object({
  id: Type.String({ description: "Defense skill ID" }),
});

const ReadAttackParams = Type.Object({
  id: Type.String({ description: "Attack ID" }),
});

const EvaluateDefenseSkillParams = Type.Object({
  id: Type.String({ description: "Defense skill ID to evaluate" }),
});

const RunDetectParams = Type.Object({
  id: Type.String({ description: "Defense skill ID" }),
  sample: Type.String({ description: "Sample content to test against" }),
});

// ── Tree formatting helper ──────────────────────────────────────

function formatTree(
  nodeId: string,
  index: any,
  defenseSkills: DefenseSkillEntry[],
  filter: string | undefined,
  lines: string[],
  depth: number,
  visited: Set<string> = new Set<string>(),
): void {
  if (visited.has(nodeId)) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${depth === 0 ? "📁 " : "├─ "}${nodeId} (cycle)`);
    return;
  }
  visited.add(nodeId);

  const node = index.trees[nodeId];
  if (!node) return;
  const ab = defenseSkills.find((a) => a.config.id === nodeId);
  if (!ab) return;

  const id = ab.config.id;
  const cat = ab.config.category;
  const tier = ab.config.tier;
  const stats = node.stats_aggregated;

  if (filter && !id.includes(filter) && !cat.includes(filter)) {
    for (const childId of node.children) {
      formatTree(childId, index, defenseSkills, filter, lines, depth + 1, visited);
    }
    return;
  }

  const indent = "  ".repeat(depth);
  const prefix = depth === 0 ? "📁 " : "├─ ";
  lines.push(
    `${indent}${prefix}${id} [${cat}] tier=${tier} ` +
    `TP=${stats.true_positives} FP=${stats.false_positives} scans=${stats.total_scans}`,
  );

  for (const childId of node.children) {
    formatTree(childId, index, defenseSkills, filter, lines, depth + 1, visited);
  }
}

// ── Tool Factory ───────────────────────────────────────────────

export function createCaitlynTools(llmCall: LlmCallFn): AgentTool[] {
  return [
    // ── 1. caitlyn_scan ──
    {
      name: "caitlyn_scan",
      label: "Scan Content",
      description:
        "Scan external content for attacks using Tier 0 script sandboxes + Tier 1 LLM classifier.",
      parameters: ScanParams,
      async execute(_toolCallId, params: any) {
        const defenseSkills = loadDefenseSkills();
        const attacks = loadAttacks();
        const result = await scan({ defenseSkills, attacks, content: params.content, llmCall });
        const summary = JSON.stringify(
          {
            verdict: result.verdict,
            confidence: result.confidence,
            tier: result.tier,
            latency_us: result.total_latency_us,
            script_matches: result.script_results
              .filter((r) => r.verdict === "malicious")
              .map((r) => ({ defenseSkill: r.defense_skill_id, confidence: r.confidence, reason: r.reason })),
          },
          null,
          2,
        );
        return textResult(summary);
      },
    },

    // ── 2. list_defense_skills ──
    {
      name: "list_defense_skills",
      label: "List Defense skills",
      description: "List all defense skills in the forest with aggregated stats.",
      parameters: ListDefenseSkillsParams,
      async execute(_toolCallId, params: any) {
        const defenseSkills = loadDefenseSkills();
        let index = loadDefenseSkillIndex() ?? buildDefenseSkillIndex(defenseSkills);
        // If the persisted index is stale (roots/trees no longer resolve),
        // rebuild it from the real forest and persist the healed index.
        const rootsResolve = (idx: typeof index) =>
          idx.roots.some((rid) => defenseSkills.some((a) => a.config.id === rid));
        if (!rootsResolve(index)) {
          index = buildDefenseSkillIndex(defenseSkills);
          saveDefenseSkillIndex(index);
        }
        const filter = (params.filter as string | undefined)?.toLowerCase();
        const lines: string[] = [];
        for (const rootId of index.roots) {
          formatTree(rootId, index, defenseSkills, filter, lines, 0);
        }
        return textResult(lines.join("\n") || "(no defense skills)");
      },
    },

    // ── 3. list_attacks ──
    {
      name: "list_attacks",
      label: "List Attacks",
      description: "List all attack samples in the attack library.",
      parameters: ListAttacksParams,
      async execute(_toolCallId, params: any) {
        const attacks = loadAttacks();
        const filter = (params.filter as string | undefined)?.toLowerCase();
        const lines: string[] = [];
        for (const ag of attacks) {
          const id = ag.config.id;
          const cat = ag.config.category;
          const tmpl = ag.config.attack_template;
          if (filter && !id.includes(filter) && !cat.includes(filter)) continue;
          const escapes = ag.config.escapes.length > 0
            ? ` [escapes: ${ag.config.escapes.join(", ")}]`
            : "";
          lines.push(`${id} (${cat}, ${tmpl})${escapes}`);
        }
        return textResult(lines.join("\n") || "(no attacks)");
      },
    },

    // ── 4. read_defense_skill ──
    {
      name: "read_defense_skill",
      label: "Read Defense skill",
      description: "Read a defense skill's full detection logic and stats.",
      parameters: ReadDefenseSkillParams,
      async execute(_toolCallId, params: any) {
        const defenseSkills = loadDefenseSkills();
        const ab = defenseSkills.find((a) => a.config.id === params.id);
        if (!ab) return textResult(`Defense skill "${params.id}" not found.`);
        const info = [
          `# ${ab.config.name}`,
          `ID: ${ab.config.id}`,
          `Category: ${ab.config.category}`,
          `Tier: ${ab.config.tier}`,
          `Generation: ${ab.config.generation}`,
          `Parent: ${ab.config.parent_id ?? "(root)"}`,
          `Stats: TP=${ab.config.stats.true_positives} FP=${ab.config.stats.false_positives} Scans=${ab.config.stats.total_scans}`,
          `Has script: ${ab.scriptPath ? "yes" : "no"}`,
          "",
          ab.readme,
        ];
        return textResult(info.join("\n"));
      },
    },

    // ── 5. read_attack ──
    {
      name: "read_attack",
      label: "Read Attack",
      description: "Read an attack's full description and payload.",
      parameters: ReadAttackParams,
      async execute(_toolCallId, params: any) {
        const attacks = loadAttacks();
        const ag = attacks.find((a) => a.config.id === params.id);
        if (!ag) return textResult(`Attack "${params.id}" not found.`);
        const info = [
          `# ${ag.config.name}`,
          `ID: ${ag.config.id}`,
          `Category: ${ag.config.category}`,
          `Injection Point: ${ag.config.injection_point}`,
          `Attack Template: ${ag.config.attack_template}`,
          `Escapes: ${ag.config.escapes.join(", ") || "(none)"}`,
          "",
          ag.readme,
          "",
          "## Payload",
          "```",
          ag.payload,
          "```",
        ];
        return textResult(info.join("\n"));
      },
    },

    // ── 6. evaluate_defense_skill ──
    {
      name: "evaluate_defense_skill",
      label: "Evaluate Defense skill",
      description: "Evaluate a defense skill against all attacks to compute TP/FP/FN.",
      parameters: EvaluateDefenseSkillParams,
      async execute(_toolCallId, params: any) {
        const defenseSkills = loadDefenseSkills();
        const attacks = loadAttacks();
        const ab = defenseSkills.find((a) => a.config.id === params.id);
        if (!ab) return textResult(`Defense skill "${params.id}" not found.`);
        if (!ab.scriptPath) return textResult(`Defense skill "${params.id}" has no detect script (Tier 1 only).`);

        let tp = 0, fp = 0, fn = 0;
        const attackResults: string[] = [];

        for (const ag of attacks) {
          const { results } = await runTier0([ab], ag.payload);
          const abResult = results.find((r) => r.defense_skill_id === ab.config.id);
          if (abResult) {
            const detected = abResult.verdict === "malicious";
            attackResults.push(
              `  ${ag.config.id}: ${detected ? "DETECTED" : "MISSED"} (conf=${abResult.confidence.toFixed(2)})`,
            );
            if (detected) tp++; else fn++;
          }
        }

        const benignSamples = [
          "Hello, can you help me find a good restaurant?",
          "What is the weather like today?",
          "Please summarize the following article about climate change.",
        ];
        for (const ben of benignSamples) {
          const { results } = await runTier0([ab], ben);
          const abResult = results.find((r) => r.defense_skill_id === ab.config.id);
          if (abResult?.verdict === "malicious") fp++;
        }

        const precision = tp + fp > 0 ? (tp / (tp + fp)).toFixed(3) : "N/A";
        const recall = tp + fn > 0 ? (tp / (tp + fn)).toFixed(3) : "N/A";

        const report = [
          `Evaluation of ${ab.config.name} (${params.id})`,
          `TP: ${tp} | FP: ${fp} | FN: ${fn}`,
          `Precision: ${precision} | Recall: ${recall}`,
          "",
          "Per-attack results:",
          ...attackResults,
        ];
        return textResult(report.join("\n"));
      },
    },

    // ── 7. run_detect_script ──
    {
      name: "run_detect_script",
      label: "Run Detect Script",
      description: "Run a single defense skill's detect script on a test sample for debugging.",
      parameters: RunDetectParams,
      async execute(_toolCallId, params: any) {
        const defenseSkills = loadDefenseSkills();
        const ab = defenseSkills.find((a) => a.config.id === params.id);
        if (!ab) return textResult(`Defense skill "${params.id}" not found.`);
        if (!ab.scriptPath) return textResult(`Defense skill "${params.id}" has no detect script.`);

        const { results } = await runTier0([ab], params.sample as string);
        const abResult = results.find((r) => r.defense_skill_id === ab.config.id);

        if (!abResult) return textResult("No result from script.");
        return textResult(JSON.stringify(
          { verdict: abResult.verdict, confidence: abResult.confidence, reason: abResult.reason, latency_us: abResult.latency_us, error: abResult.error },
          null, 2,
        ));
      },
    },

    // ── 8. scan_history ──
    {
      name: "scan_history",
      label: "Scan History",
      description: "View recent scan history: verdicts, latencies, defense skill matches.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Number of entries (default: 20)" })),
      }),
      async execute(_toolCallId, params: any) {
        const limit: number = params.limit ?? 20;
        const entries = getHistory(limit);
        if (entries.length === 0) return textResult("No scan history yet.");
        const lines = entries.map((e) => {
          const emoji = e.verdict === "malicious" ? "🚨" : "✅";
          const ab = e.defense_skill_hits.length > 0 ? ` [${e.defense_skill_hits.join(", ")}]` : "";
          return `${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} (${(e.confidence * 100).toFixed(0)}%) | T${e.tier} | ${(e.total_latency_us / 1000).toFixed(1)}ms${ab} | ${e.content_preview}`;
        });
        return textResult(lines.join("\n"));
      },
    },

    // ── 9. dashboard ──
    {
      name: "dashboard",
      label: "Cost Dashboard",
      description: "Aggregated defense statistics: total scans, detection rate, latency, token costs, top defense skills.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params: any) {
        const stats = getDashboard();
        if (stats.total_scans === 0) return textResult("📊 No scan data yet. Run caitlyn_scan to collect stats.");
        const topAb = stats.top_defense_skills.length > 0
          ? stats.top_defense_skills.map((a) => `  ${a.id}: ${a.hits} hits`).join("\n")
          : "  (none)";
        const report = [
          "📊 CAITLYN Defense Dashboard",
          "═══════════════════════════",
          "",
          `Total Scans:      ${stats.total_scans}`,
          `Detected (🚨):    ${stats.malicious_count}`,
          `Clean (✅):       ${stats.benign_count}`,
          `Detection Rate:   ${(stats.detection_rate * 100).toFixed(1)}%`,
          "",
          `Avg Latency:      ${stats.avg_latency_ms.toFixed(2)}ms`,
          `Avg Tokens:       ${stats.avg_tokens.toFixed(1)}`,
          `Total Tokens:     ${stats.total_tokens}`,
          "",
          `Tier 0 Hits:      ${stats.tier0_hits}`,
          `Tier 1 Hits:      ${stats.tier1_hits}`,
          "",
          `Last Scan:        ${stats.last_scan_at ?? "N/A"}`,
          "",
          "Top Defense skills:",
          topAb,
        ];
        return textResult(report.join("\n"));
      },
    },

    // ── 10. detect_agents ──
    {
      name: "detect_agents",
      label: "Detect Agents",
      description:
        "Detect AI agents installed on this host (claude-code, codex, opencode, openclaw, pi, ...), whether CAITLYN hooks are installed for them, and which directories CAITLYN watches to protect them.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params: any) {
        const { detectAgents, isHookInstalled, getWatchDirsForAgents } = await import("./adapters/registry.js");
        const results = detectAgents();
        const watch = getWatchDirsForAgents();
        if (results.length === 0) {
          return textResult("No known agent types detected on this host.");
        }
        const lines: string[] = [];
        lines.push(`Detected agents on this host (${results.length} known types):`);
        for (const r of results) {
          const status = r.installed ? "PRESENT" : "not found";
          const hook = isHookInstalled(r.agent.id) ? "hooks ✓" : "hooks ✗";
          const dirs = watch.agentDirs[r.agent.id] ?? [];
          const dirPart = dirs.length > 0 ? ` watches: ${dirs.join(", ")}` : "";
          lines.push(`  ${r.agent.id} (${status}, ${hook}, integration: ${r.agent.integrationMethod})${dirPart}`);
          if (r.installed) {
            lines.push(`    found: ${r.foundPaths.join(", ")}`);
          }
        }
        lines.push("");
        lines.push("To protect an agent, install its hook: caitlyn install <agent-id> (CLI).");
        return textResult(lines.join("\n"));
      },
    },

    // ── 11. caitlyn_synthesize ──
    {
      name: "caitlyn_synthesize",
      label: "Trigger Synthesis",
      description: "Evolve new defense skills via the System 2 loop (LLM synthesis + deterministic verification + independent review).",
      parameters: Type.Object({
        pattern: Type.String({ description: "Threat pattern or attack description to evolve defense against" }),
      }),
      async execute(_toolCallId, params: any) {
        const config = loadEvolutionConfig();
        const engine = new EvolutionEngine({
          config,
          generatorLlm: llmCall,
          reviewerLlm: llmCall,
        });
        const clusterId = buildClusterId(params.pattern);
        const benign = loadHistory()
          .filter((h) => h.verdict === "benign")
          .slice(0, config.benignSamples)
          .map((h) => h.content_preview);
        const outcome = await engine.run({
          clusterId,
          target: `agent-requested synthesis for cluster ${clusterId}`,
          profile: {
            clusterId,
            category: "unknown",
            features: extractAttackFeatures([params.pattern]),
            sampleCount: 1,
          },
          mustDetect: [params.pattern],
          benign,
          hasSamples: true,
        });
        const { loop } = outcome;
        if (loop.approved.length === 0) {
          return textResult(
            `Synthesis loop finished: ${loop.termination} (${loop.rounds} rounds, ` +
            `~${loop.tokensUsed} tokens). No defense skill accepted.`,
          );
        }
        const lines = loop.approved.map(
          (vc) => `  ${vc.draft.id}: ${vc.draft.name} (${vc.draft.signatures.length} signatures)`,
        );
        const shadowNote =
          outcome.shadowStarted.length > 0
            ? `\nShadow observation started: ${outcome.shadowStarted.join(", ")}`
            : "";
        return textResult(
          `Synthesis complete — ${loop.approved.length} defense skill(s):\n` +
          `${lines.join("\n")}${shadowNote}`,
        );
      },
    },
  ];
}
