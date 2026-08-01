/**
 * CAITLYN Agent — REPL
 */

import * as readline from "node:readline";
import type { Agent } from "@earendil-works/pi-agent-core";
import { scan, type LlmCallFn } from "./scanner.js";
import { loadAntibodies, loadAntigens, loadAntibodyIndex, buildAntibodyIndex } from "./library.js";
import { resolveModel } from "./llm.js";
import { getDashboard, getHistory } from "./history.js";
import { loadConfig } from "./config.js";
import { complete } from "@earendil-works/pi-ai/compat";
import { getCredentialEnv } from "./config/credentials.js";

const BANNER = `
┌──────────────────────────────────────────────────┐
│  🛡️  CAITLYN Security Guardian Agent                 │
│  Continuous Agents for Injection Threats via Lifelong Yielding Nexus    │
│                                                   │
│  Type /help for commands, /quit to exit           │
│  Type any content to scan it for attacks          │
└──────────────────────────────────────────────────┘
`;

const HELP = `
Commands:
  /scan <content>   — Scan content for attacks
  /status           — Show antibody/antigen library status
  /dashboard        — Show defense stats (scans, latency, tokens)
  /history [N]      — Show recent scan history
  /help             — Show this help
  /quit, /exit      — Exit CAITLYN

Multi-line: end with a line containing only "." (period)
`;

let llmCache: LlmCallFn | null = null;
async function getLlm(): Promise<LlmCallFn> {
  if (llmCache) return llmCache;
  const config = loadConfig();
  const model = resolveModel(config);
  const credentialEnv = getCredentialEnv(config.provider);
  llmCache = async (sp: string, up: string) => {
    const ctx = {
      systemPrompt: sp,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: up }], timestamp: Date.now() },
      ],
    };
    const r = await complete(model, ctx, credentialEnv ? { env: credentialEnv } : undefined);
    return r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("");
  };
  return llmCache;
}

export function startRepl(agent: Agent) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "caitlyn> " });
  console.log(BANNER); rl.prompt();

  // Handle SIGINT gracefully — don't kill the REPL, just cancel current input
  process.on("SIGINT", () => {
    console.log("\n^C — Type /quit to exit.");
    rl.prompt();
  });

  let buf: string[] = []; let multi = false;
  rl.on("line", async (input: string) => {
    const t = input.trim();
    if (multi) {
      if (t === ".") { multi = false; const c = buf.join("\n"); buf = []; await doScan(c); rl.prompt(); return; }
      buf.push(t); rl.prompt(); return;
    }
    if (t.startsWith("/scan ")) { await doScan(t.slice(6)); rl.prompt(); return; }
    switch (t) {
      case "/dashboard": await doDashboard(); break;
      case "/history": await doHistory(input); break;
      case "/status": await doStatus(); break;
      case "/help": console.log(HELP); break;
      case "/quit": case "/exit": console.log("Goodbye."); rl.close(); break;
      case "": break;
      default: try { await agent.prompt(t); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

async function doScan(content: string) {
  console.log(`🔍 Scanning (${content.length} chars)...`);
  try {
    const abs = loadAntibodies(); const ags = loadAntigens();
    const r = await scan({ antibodies: abs, antigens: ags, content, llmCall: await getLlm() });
    console.log(`${r.verdict === "malicious" ? "🚨" : "✅"} ${r.verdict.toUpperCase()} (${(r.confidence*100).toFixed(1)}%) [Tier ${r.tier}]`);
    for (const m of r.script_results.filter(x => x.verdict === "malicious")) {
      console.log(`     - ${m.antibody_id}: ${m.reason ?? "no reason"}`);
    }
  } catch (e) { console.error("❌", e instanceof Error ? e.message : String(e)); }
}

async function doStatus() {
  const abs = loadAntibodies(); const ags = loadAntigens();
  const idx = loadAntibodyIndex() ?? buildAntibodyIndex(abs);
  console.log(`🛡️  CAITLYN: ${abs.length} antibodies (${idx.roots.length} roots), ${ags.length} antigens`);
  for (const rid of idx.roots) {
    const ab = abs.find(a => a.config.id === rid);
    if (ab) console.log(`   📁 ${rid} [${ab.config.category}] t${ab.config.tier}`);
  }
}

async function doDashboard() {
  const stats = getDashboard();
  if (stats.total_scans === 0) { console.log("📊 No scan data yet."); return; }
  console.log(`📊 CAITLYN Defense Dashboard`);
  console.log(`   Scans: ${stats.total_scans} | Detected: ${stats.malicious_count} | Clean: ${stats.benign_count}`);
  console.log(`   Detection Rate: ${(stats.detection_rate * 100).toFixed(1)}%`);
  console.log(`   Avg Latency: ${stats.avg_latency_ms.toFixed(2)}ms | Avg Tokens: ${stats.avg_tokens.toFixed(1)} | Total: ${stats.total_tokens}`);
  console.log(`   Tier 0: ${stats.tier0_hits} | Tier 1: ${stats.tier1_hits}`);
  console.log(`   Last Scan: ${stats.last_scan_at ?? "N/A"}`);
  if (stats.top_antibodies.length > 0) {
    for (const a of stats.top_antibodies.slice(0, 5)) console.log(`   - ${a.id}: ${a.hits} hits`);
  }
}

async function doHistory(input: string) {
  const limit = parseInt(input.split(" ")[1] ?? "20") || 20;
  const entries = getHistory(limit);
  if (entries.length === 0) { console.log("No scan history yet."); return; }
  for (const e of entries) {
    const emoji = e.verdict === "malicious" ? "🚨" : "✅";
    console.log(`${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} | T${e.tier} | ${e.content_preview}`);
  }
}
