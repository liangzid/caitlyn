/**
 * CAITLYN Agent — Tool Definitions
 *
 * 10 tools registered with the pi Agent harness:
 *   caitlyn_scan, list_antibodies, list_antigens, read_antibody,
 *   read_antigen, evaluate_antibody, run_detect_script,
 *   scan_history, dashboard, caitlyn_vaccinate
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { loadAntibodies, loadAntigens, loadAntibodyIndex, buildAntibodyIndex, saveAntibody, ANTIBODIES_DIR } from "./library.js";
import { scan, runTier0, type LlmCallFn } from "./scanner.js";
import { getDashboard, getHistory } from "./history.js";
import type { AntibodyEntry, AntibodyConfig } from "./schema.js";
import * as path from "node:path";

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

const ListAntibodiesParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter by category or id substring" })),
});

const ListAntigensParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter by category or id substring" })),
});

const ReadAntibodyParams = Type.Object({
  id: Type.String({ description: "Antibody ID" }),
});

const ReadAntigenParams = Type.Object({
  id: Type.String({ description: "Antigen ID" }),
});

const EvaluateAntibodyParams = Type.Object({
  id: Type.String({ description: "Antibody ID to evaluate" }),
});

const RunDetectParams = Type.Object({
  id: Type.String({ description: "Antibody ID" }),
  sample: Type.String({ description: "Sample content to test against" }),
});

// ── Tree formatting helper ──────────────────────────────────────

function formatTree(
  nodeId: string,
  index: any,
  antibodies: AntibodyEntry[],
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
  const ab = antibodies.find((a) => a.config.id === nodeId);
  if (!ab) return;

  const id = ab.config.id;
  const cat = ab.config.category;
  const tier = ab.config.tier;
  const stats = node.stats_aggregated;

  if (filter && !id.includes(filter) && !cat.includes(filter)) {
    for (const childId of node.children) {
      formatTree(childId, index, antibodies, filter, lines, depth + 1, visited);
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
    formatTree(childId, index, antibodies, filter, lines, depth + 1, visited);
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
        const antibodies = loadAntibodies();
        const antigens = loadAntigens();
        const result = await scan({ antibodies, antigens, content: params.content, llmCall });
        const summary = JSON.stringify(
          {
            verdict: result.verdict,
            confidence: result.confidence,
            tier: result.tier,
            latency_us: result.total_latency_us,
            script_matches: result.script_results
              .filter((r) => r.verdict === "malicious")
              .map((r) => ({ antibody: r.antibody_id, confidence: r.confidence, reason: r.reason })),
          },
          null,
          2,
        );
        return textResult(summary);
      },
    },

    // ── 2. list_antibodies ──
    {
      name: "list_antibodies",
      label: "List Antibodies",
      description: "List all antibodies in the forest with aggregated stats.",
      parameters: ListAntibodiesParams,
      async execute(_toolCallId, params: any) {
        const antibodies = loadAntibodies();
        const index = loadAntibodyIndex() ?? buildAntibodyIndex(antibodies);
        const filter = (params.filter as string | undefined)?.toLowerCase();
        const lines: string[] = [];
        for (const rootId of index.roots) {
          formatTree(rootId, index, antibodies, filter, lines, 0);
        }
        return textResult(lines.join("\n") || "(no antibodies)");
      },
    },

    // ── 3. list_antigens ──
    {
      name: "list_antigens",
      label: "List Antigens",
      description: "List all attack samples in the antigen library.",
      parameters: ListAntigensParams,
      async execute(_toolCallId, params: any) {
        const antigens = loadAntigens();
        const filter = (params.filter as string | undefined)?.toLowerCase();
        const lines: string[] = [];
        for (const ag of antigens) {
          const id = ag.config.id;
          const cat = ag.config.category;
          const tmpl = ag.config.attack_template;
          if (filter && !id.includes(filter) && !cat.includes(filter)) continue;
          const escapes = ag.config.escapes.length > 0
            ? ` [escapes: ${ag.config.escapes.join(", ")}]`
            : "";
          lines.push(`${id} (${cat}, ${tmpl})${escapes}`);
        }
        return textResult(lines.join("\n") || "(no antigens)");
      },
    },

    // ── 4. read_antibody ──
    {
      name: "read_antibody",
      label: "Read Antibody",
      description: "Read an antibody's full detection logic and stats.",
      parameters: ReadAntibodyParams,
      async execute(_toolCallId, params: any) {
        const antibodies = loadAntibodies();
        const ab = antibodies.find((a) => a.config.id === params.id);
        if (!ab) return textResult(`Antibody "${params.id}" not found.`);
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

    // ── 5. read_antigen ──
    {
      name: "read_antigen",
      label: "Read Antigen",
      description: "Read an antigen's full description and payload.",
      parameters: ReadAntigenParams,
      async execute(_toolCallId, params: any) {
        const antigens = loadAntigens();
        const ag = antigens.find((a) => a.config.id === params.id);
        if (!ag) return textResult(`Antigen "${params.id}" not found.`);
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

    // ── 6. evaluate_antibody ──
    {
      name: "evaluate_antibody",
      label: "Evaluate Antibody",
      description: "Evaluate an antibody against all antigens to compute TP/FP/FN.",
      parameters: EvaluateAntibodyParams,
      async execute(_toolCallId, params: any) {
        const antibodies = loadAntibodies();
        const antigens = loadAntigens();
        const ab = antibodies.find((a) => a.config.id === params.id);
        if (!ab) return textResult(`Antibody "${params.id}" not found.`);
        if (!ab.scriptPath) return textResult(`Antibody "${params.id}" has no detect script (Tier 1 only).`);

        let tp = 0, fp = 0, fn = 0;
        const antigenResults: string[] = [];

        for (const ag of antigens) {
          const { results } = await runTier0([ab], ag.payload);
          const abResult = results.find((r) => r.antibody_id === ab.config.id);
          if (abResult) {
            const detected = abResult.verdict === "malicious";
            antigenResults.push(
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
          const abResult = results.find((r) => r.antibody_id === ab.config.id);
          if (abResult?.verdict === "malicious") fp++;
        }

        const precision = tp + fp > 0 ? (tp / (tp + fp)).toFixed(3) : "N/A";
        const recall = tp + fn > 0 ? (tp / (tp + fn)).toFixed(3) : "N/A";

        const report = [
          `Evaluation of ${ab.config.name} (${params.id})`,
          `TP: ${tp} | FP: ${fp} | FN: ${fn}`,
          `Precision: ${precision} | Recall: ${recall}`,
          "",
          "Per-antigen results:",
          ...antigenResults,
        ];
        return textResult(report.join("\n"));
      },
    },

    // ── 7. run_detect_script ──
    {
      name: "run_detect_script",
      label: "Run Detect Script",
      description: "Run a single antibody's detect script on a test sample for debugging.",
      parameters: RunDetectParams,
      async execute(_toolCallId, params: any) {
        const antibodies = loadAntibodies();
        const ab = antibodies.find((a) => a.config.id === params.id);
        if (!ab) return textResult(`Antibody "${params.id}" not found.`);
        if (!ab.scriptPath) return textResult(`Antibody "${params.id}" has no detect script.`);

        const { results } = await runTier0([ab], params.sample as string);
        const abResult = results.find((r) => r.antibody_id === ab.config.id);

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
      description: "View recent scan history: verdicts, latencies, antibody matches.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Number of entries (default: 20)" })),
      }),
      async execute(_toolCallId, params: any) {
        const limit: number = params.limit ?? 20;
        const entries = getHistory(limit);
        if (entries.length === 0) return textResult("No scan history yet.");
        const lines = entries.map((e) => {
          const emoji = e.verdict === "malicious" ? "🚨" : "✅";
          const ab = e.antibody_hits.length > 0 ? ` [${e.antibody_hits.join(", ")}]` : "";
          return `${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} (${(e.confidence * 100).toFixed(0)}%) | T${e.tier} | ${(e.total_latency_us / 1000).toFixed(1)}ms${ab} | ${e.content_preview}`;
        });
        return textResult(lines.join("\n"));
      },
    },

    // ── 9. dashboard ──
    {
      name: "dashboard",
      label: "Cost Dashboard",
      description: "Aggregated defense statistics: total scans, detection rate, latency, token costs, top antibodies.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params: any) {
        const stats = getDashboard();
        if (stats.total_scans === 0) return textResult("📊 No scan data yet. Run caitlyn_scan to collect stats.");
        const topAb = stats.top_antibodies.length > 0
          ? stats.top_antibodies.map((a) => `  ${a.id}: ${a.hits} hits`).join("\n")
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
          "Top Antibodies:",
          topAb,
        ];
        return textResult(report.join("\n"));
      },
    },

    // ── 10. caitlyn_vaccinate ──
    {
      name: "caitlyn_vaccinate",
      label: "Trigger Vaccination",
      description: "Evolve a new antibody variant for a threat pattern using LLM-guided mutation.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Threat pattern or attack description to evolve defense against" }),
        parent_id: Type.Optional(Type.String({ description: "Parent antibody ID to mutate from" })),
      }),
      async execute(_toolCallId, params: any) {
        const antibodies = loadAntibodies();
        const parent = params.parent_id
          ? antibodies.find((a) => a.config.id === params.parent_id)
          : antibodies.find((a) => a.config.category === "injection" && a.config.tier === 0) ?? antibodies[0];

        if (!parent) return textResult("No parent antibody available for vaccination.");

        const systemPrompt = [
          "You are CAITLYN's vaccination engine. Given a parent antibody and a threat pattern,",
          "generate a new antibody variant that is more specialized against the specific pattern.",
          "Output a single JSON object:",
          '{ "id": "ab-<category>-<variant>", "name": "...", "category": "injection|jailbreak|poisoning|exfiltration",',
          '  "tier": 0, "threshold": 0.7, "detect_logic": "... (regex or heuristic description)" }',
        ].join("\n");

        const userPrompt = [
          `Parent antibody: ${parent.config.name} (${parent.config.id})`,
          `Category: ${parent.config.category}`,
          `Current detection: ${parent.readme.slice(0, 500)}`,
          "",
          `Threat pattern to counter: ${params.pattern.slice(0, 2000)}`,
        ].join("\n");

        const response = await llmCall(systemPrompt, userPrompt);
        let variant: Record<string, unknown>;
        try {
          const jsonStr = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          variant = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          return textResult(`Vaccination LLM output could not be parsed as JSON:\n${response.slice(0, 500)}`);
        }

        const newId = (variant.id as string) ?? `ab-${parent.config.category}-v${Date.now()}`;
        // Build and persist the new antibody
        const abDir = path.join(ANTIBODIES_DIR, newId);
        const entry = {
          config: {
            id: newId,
            name: (variant.name as string) ?? newId,
            parent_id: parent.config.id,
            category: (variant.category as AntibodyConfig["category"]) ?? parent.config.category,
            tier: (variant.tier as 0 | 1 | 2) ?? 0,
            threshold: (variant.threshold as number) ?? 0.7,
            description: (variant.description as string) ?? "",
            affinity_score: (variant.affinity_score as number) ?? 0,
            created_at: new Date().toISOString(),
            generation: parent.config.generation + 1,
            stats: { true_positives: 0, false_positives: 0, total_scans: 0, avg_latency_us: 0 },
            deps: [parent.config.id],
            signatures: (variant.signatures as AntibodyConfig["signatures"]) ?? [],
          } satisfies AntibodyConfig,
          readme: `# ${variant.name ?? newId}\n\nVaccinated from ${parent.config.id}.\nTarget pattern: ${params.pattern.slice(0, 200)}`,
          scriptPath: null,
          folderPath: abDir,
        } satisfies AntibodyEntry;
        saveAntibody(entry);

        const info = [
          `💉 Vaccination candidate generated and saved:`,
          `  ID: ${newId}`,
          `  Name: ${variant.name ?? "unnamed"}`,
          `  Category: ${variant.category ?? parent.config.category}`,
          `  Tier: ${variant.tier ?? 0}`,
          `  Threshold: ${variant.threshold ?? 0.7}`,
          `  Location: ${abDir}`,
          "",
          `${(variant.detect_logic as string)?.slice(0, 300) ?? "N/A"}`,
        ];
        return textResult(info.join("\n"));
      },
    },
  ];
}
