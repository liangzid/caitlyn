#!/usr/bin/env node
/**
 * CAITLYN Agent — CLI Entry Point
 *
 * Commands:
 *   caitlyn tui               Full-screen Terminal UI (default)
 *   caitlyn repl              Basic readline REPL
 *   caitlyn scan <content>    Quick security scan
 *   caitlyn status            Show antibody/antigen library status
 *   caitlyn dashboard         Show defense stats dashboard
 *   caitlyn history [N]       Show recent scan history
 *   caitlyn providers         List available LLM providers
 */

import { createCaitlynAgent } from "./agent.js";
import { startRepl } from "./repl.js";
import { CaitlynTUI } from "./caitlyn-tui.js";
import { loadConfig } from "./config.js";
import { getProviders, getModels, resolveModel } from "./llm.js";
import { scan, type LlmCallFn } from "./scanner.js";
import { hybridScan } from "./hybrid-scanner.js";
import { loadAntibodies, loadAntigens, loadAntibodyIndex, buildAntibodyIndex } from "./library.js";
import { complete } from "@earendil-works/pi-ai/compat";
import { getDashboard, getHistory } from "./history.js";

const args = process.argv.slice(2);
const command = args[0];

async function makeLlmCall(): Promise<LlmCallFn> {
  const config = loadConfig();
  const model = resolveModel(config);
  return async (systemPrompt: string, userPrompt: string) => {
    const ctx = {
      systemPrompt,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: userPrompt }], timestamp: Date.now() },
      ],
    };
    const response = await complete(model, ctx);
    const textBlocks = response.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    return textBlocks.map((c) => c.text).join("");
  };
}

async function main() {
  // Default: TUI mode
  if (!command || command === "tui") {
    const llmCall = await makeLlmCall();
    const tui = await CaitlynTUI.create(llmCall);
    await tui.run();
    return;
  }

  // REPL mode
  if (command === "repl") {
    const { agent } = await createCaitlynAgent();
    startRepl(agent);
    return;
  }

  switch (command) {
    case "providers": {
      for (const p of getProviders()) {
        const models = getModels(p);
        console.log(`  ${p}`);
        for (const m of models.slice(0, 5)) console.log(`    - ${m.id}`);
        if (models.length > 5) console.log(`    ... and ${models.length - 5} more`);
      }
      process.exit(0);
    }
    case "scan": {
      if (args.length < 2) { console.log("Usage: caitlyn scan <content>"); process.exit(1); }
      const content = args.slice(1).join(" ");
      const llmCall = await makeLlmCall();
      console.log(`🔍 Scanning (${content.length} chars)...`);
      try {
        const result = await hybridScan({ content, llmCall });
        const emoji = result.verdict === "malicious" ? "🚨" : "✅";
        console.log(`${emoji} ${result.verdict.toUpperCase()} (${(result.confidence * 100).toFixed(1)}%) [${result.backend}]`);
        console.log(`   Latency: ${(result.total_latency_us / 1000).toFixed(1)}ms | Tokens: ${result.total_tokens}`);
        for (const m of result.script_results.filter((r) => r.verdict === "malicious")) {
          console.log(`     - ${m.antibody_id}: ${m.reason ?? "no reason"}`);
        }
        process.exit(result.verdict === "malicious" ? 1 : 0);
      } catch (err) {
        console.error("❌ Scan failed:", err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    case "status": {
      const antibodies = loadAntibodies();
      const antigens = loadAntigens();
      const index = loadAntibodyIndex() ?? buildAntibodyIndex(antibodies);
      console.log(`🛡️  CAITLYN: ${antibodies.length} antibodies (${index.roots.length} roots), ${antigens.length} antigens`);
      for (const rootId of index.roots) {
        const ab = antibodies.find((a) => a.config.id === rootId);
        if (ab) console.log(`   📁 ${rootId} [${ab.config.category}] tier=${ab.config.tier}`);
      }
      const byCat: Record<string, number> = {};
      for (const ag of antigens) byCat[ag.config.category] = (byCat[ag.config.category] || 0) + 1;
      for (const [cat, count] of Object.entries(byCat)) console.log(`   - ${cat}: ${count}`);
      process.exit(0);
    }
    case "dashboard": {
      const stats = getDashboard();
      if (stats.total_scans === 0) { console.log("📊 No scan data yet."); process.exit(0); }
      console.log("📊 CAITLYN Defense Dashboard");
      console.log("═══════════════════════════");
      console.log(`Total Scans:      ${stats.total_scans}`);
      console.log(`Detected (🚨):    ${stats.malicious_count}`);
      console.log(`Clean (✅):       ${stats.benign_count}`);
      console.log(`Detection Rate:   ${(stats.detection_rate * 100).toFixed(1)}%`);
      console.log(`Avg Latency:      ${stats.avg_latency_ms.toFixed(2)}ms`);
      console.log(`Avg Tokens:       ${stats.avg_tokens.toFixed(1)}`);
      console.log(`Total Tokens:     ${stats.total_tokens}`);
      console.log(`Tier 0 Hits:      ${stats.tier0_hits}`);
      console.log(`Tier 1 Hits:      ${stats.tier1_hits}`);
      console.log(`Last Scan:        ${stats.last_scan_at ?? "N/A"}`);
      if (stats.top_antibodies.length > 0) {
        console.log("Top Antibodies:");
        for (const a of stats.top_antibodies) console.log(`  ${a.id}: ${a.hits} hits`);
      }
      process.exit(0);
    }
    case "history": {
      const entries = getHistory(args[1] ? parseInt(args[1]) : 20);
      if (entries.length === 0) { console.log("No scan history yet."); process.exit(0); }
      for (const e of entries) {
        const emoji = e.verdict === "malicious" ? "🚨" : "✅";
        console.log(`${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} | T${e.tier} | ${e.content_preview}`);
      }
      process.exit(0);
    }
    default: {
      console.log(`Unknown command: ${command}`);
      console.log("Usage: caitlyn [tui|repl|scan|status|dashboard|history|providers]");
      process.exit(1);
    }
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
