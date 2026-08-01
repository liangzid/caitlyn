/**
 * CAITLYN TUI Command Handlers
 *
 * Standalone functions implementing slash-command and bang-command behavior.
 * Each takes a TUIHost (the CaitlynTUI instance) as its first argument so the
 * main class stays focused on wiring and interaction flow.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Container,
  Text,
  SelectList,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { LlmCallFn } from "../scanner.js";
import { hybridScan } from "../hybrid-scanner.js";
import {
  buildAntibodyIndex,
  invalidateLibraryCache,
  loadAntibodies,
  loadAntigens,
  saveAntibody,
  saveAntibodyIndex,
  ANTIBODIES_DIR,
} from "../library.js";
import { loadEvolutionConfig } from "../config.js";
import { EvolutionEngine } from "../evolution/engine.js";
import { buildClusterId, extractAntigenFeatures } from "../evolution/features.js";
import { loadHistory } from "../history.js";
import { SessionManager } from "../session/session-manager.js";
import type { AntibodyEntry, ScriptResult } from "../schema.js";
import type { MessageEntry, SessionInfoEntry } from "../session/session-types.js";
import { getContextWindow, getModelDisplay } from "../config/models.js";
import { getProviders, getModels } from "../llm.js";
import { listConfiguredProviders, persistApiKey } from "../config/credentials.js";
import { C, PAL, fg, paint, badge, bar, gradText, selectListTheme, estimateTokens, translateLlmError, verdictMeta, categoryColor, tierColor } from "../theme.js";
import { buildSessionPickerOverlay } from "../components/overlays.js";
import type { FooterComponent } from "../components/footer.js";
import type { Editor } from "@earendil-works/pi-tui";

// ── Host Interface ────────────────────────────────────────────────

/**
 * Subset of CaitlynTUI that command handlers need.
 * CaitlynTUI satisfies this structurally — no `implements` clause required.
 */
export interface TUIHost {
  tui: TUI;
  editor: Editor;
  footer: FooterComponent;
  agent: Agent | null;
  llmCall: LlmCallFn;
  sessionMgr: SessionManager;
  currentProvider: string;
  currentModelId: string;
  showSystemMessage(content: string): void;
  refreshFooter(): void;
}

// ── Scan ──────────────────────────────────────────────────────────

export async function doScan(self: TUIHost, content: string): Promise<void> {
  self.showSystemMessage(`${fg(PAL.cyan)}◈ ${C.reset}${fg(PAL.dim)}Scanning ${content.length} chars...${C.reset}`);

  // Live progress in the footer status bar (spinner + elapsed seconds)
  const scanStart = Date.now();
  self.footer.update({ scanning: true, scanSeconds: 0 });
  self.footer.invalidate();
  self.tui.requestRender();
  const progressTimer = setInterval(() => {
    self.footer.update({ scanSeconds: (Date.now() - scanStart) / 1000 });
    self.footer.invalidate();
    self.tui.requestRender();
  }, 500);

  try {
    const result = await hybridScan({ content, llmCall: self.llmCall });

    const meta = verdictMeta(result.verdict);
    const rate = Math.max(0, Math.min(1, result.confidence));
    const verdictColor = result.verdict === "malicious" ? PAL.danger
      : result.verdict === "suspicious" ? PAL.warn
      : PAL.ok;

    let output = paint(` ${meta.icon}  ${result.verdict.toUpperCase()}  ${meta.icon} `, meta.fg, meta.bg, true);
    output += `\n${fg(PAL.faint)}confidence${C.reset} ${bar(rate, 20, verdictColor)} ${fg(verdictColor)}${C.bold}${(rate * 100).toFixed(1)}%${C.reset}`;
    output += `\n${fg(PAL.faint)}latency${C.reset} ${fg(PAL.text)}${(result.total_latency_us / 1000).toFixed(1)}ms${C.reset}`;
    output += `  ${fg(PAL.faint)}tokens${C.reset} ${fg(PAL.text)}${result.total_tokens}${C.reset}`;
    output += `  ${badge(`T${result.tier}`, tierColor(result.tier), PAL.panelHi, false)}`;
    output += `  ${fg(PAL.faint)}${result.backend}${C.reset}`;

    const hits = result.script_results.filter((r: ScriptResult) => r.verdict === "malicious");
    if (hits.length > 0) {
      // Map antibody ids → configs to color-code by category
      const abById = new Map(loadAntibodies().map((a) => [a.config.id, a.config]));
      output += `\n\n${gradText("MATCHED ANTIBODIES", PAL.cyan, PAL.violet, true)}\n`;
      for (const h of hits) {
        const cat = abById.get(h.antibody_id)?.category ?? "unknown";
        const cc = categoryColor(cat);
        output += ` ${fg(cc)}●${C.reset} ${fg(PAL.text)}${h.antibody_id}${C.reset} ${fg(PAL.faint)}— ${h.reason ?? "detected"} (${(h.confidence * 100).toFixed(0)}%)${C.reset}\n`;
      }
    }

    self.showSystemMessage(output);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    self.showSystemMessage(`${C.red}❌ Scan failed:${C.reset} ${translateLlmError(err)}`);
  } finally {
    clearInterval(progressTimer);
    self.footer.update({ scanning: false });
    self.refreshFooter();
  }
}

// ── Antibody / Antigen ────────────────────────────────────────────

export async function doAntibodyList(self: TUIHost): Promise<void> {
  const antibodies = loadAntibodies();
  if (antibodies.length === 0) { self.showSystemMessage("No antibodies loaded."); return; }
  let out = `${gradText("ANTIBODY FOREST", PAL.cyan, PAL.violet, true)}  ${badge(`${antibodies.length} LOADED`, PAL.cyan, PAL.cyanBg, false)}\n`;
  for (const ab of antibodies) {
    const cc = categoryColor(ab.config.category);
    out += ` ${fg(cc)}◆${C.reset} ${fg(PAL.text)}${ab.config.id}${C.reset} ${badge(ab.config.category.toUpperCase(), cc, PAL.panelHi, false)} ${badge(`T${ab.config.tier}`, tierColor(ab.config.tier), PAL.panelHi, false)} ${fg(PAL.faint)}gen ${ab.config.generation}${C.reset}\n`;
  }
  self.showSystemMessage(out);
}

export async function doAntibodyAdd(self: TUIHost, id: string): Promise<void> {
  await doAntibodyAddFull(self, id, "injection", 0);
}

const ADD_CATEGORIES = ["injection", "jailbreak", "poisoning", "exfiltration"] as const;

/** Minimal Tier 0 detector script (empty detector — matches nothing). */
const TIER0_DETECT_TEMPLATE = [
  "// detect.ts — created via CAITLYN TUI /antibody add",
  "// Reads content from stdin and outputs one JSON verdict line.",
  'import { readFileSync } from "node:fs";',
  'const content = readFileSync(0, "utf-8");',
  'console.log(JSON.stringify({ verdict: "benign", confidence: 0, reason: null }));',
  "",
].join("\n");

export async function doAntibodyAddFull(
  self: TUIHost,
  id: string,
  category: string,
  tier: number,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    self.showSystemMessage(`${C.red}Invalid antibody id:${C.reset} use lowercase letters, digits and dashes.`);
    return;
  }
  if (!(ADD_CATEGORIES as readonly string[]).includes(category)) {
    self.showSystemMessage(`${C.red}Invalid category:${C.reset} ${ADD_CATEGORIES.join(" | ")}`);
    return;
  }
  if (tier !== 0 && tier !== 1 && tier !== 2) {
    self.showSystemMessage(`${C.red}Invalid tier:${C.reset} 0 | 1 | 2`);
    return;
  }
  const dirPath = path.join(ANTIBODIES_DIR, id);
  if (fs.existsSync(dirPath)) {
    self.showSystemMessage(`${C.yellow}Antibody "${id}" already exists.${C.reset}`);
    return;
  }

  const entry: AntibodyEntry = {
    config: {
      id,
      name: id,
      description: `Created via CAITLYN TUI (${category}, tier ${tier})`,
      category: category as AntibodyEntry["config"]["category"],
      tier: tier as 0 | 1 | 2,
      threshold: 0.6,
      affinity_score: 0,
      created_at: new Date().toISOString(),
      parent_id: null,
      generation: 0,
      deps: [],
      signatures: [],
      stats: {
        total_scans: 0,
        true_positives: 0,
        false_positives: 0,
        avg_latency_us: 0,
      },
    },
    readme: `# ${id}\n\nCreated via CAITLYN TUI /antibody add.\n`,
    scriptPath: null,
    folderPath: dirPath,
  };
  saveAntibody(entry);
  fs.writeFileSync(path.join(dirPath, "README.md"), entry.readme, "utf-8");
  if (tier === 0) {
    fs.writeFileSync(path.join(dirPath, "detect.ts"), TIER0_DETECT_TEMPLATE, "utf-8");
  }
  self.showSystemMessage(
    `${C.green}✅ Antibody "${id}" created${C.reset} (${category}, tier ${tier}).\n` +
    `${C.dim}Run "npm run build" in caitlyn-agent/ to precompile detect.mjs.${C.reset}`,
  );
}

export async function doAntibodyRemove(self: TUIHost, id: string): Promise<void> {
  const dirPath = path.join(ANTIBODIES_DIR, id);
  if (!fs.existsSync(dirPath)) {
    self.showSystemMessage(`Antibody "${id}" not found.`);
    return;
  }
  const trashDir = path.join(ANTIBODIES_DIR, ".trash");
  fs.mkdirSync(trashDir, { recursive: true });
  const target = path.join(trashDir, `${id}-${Date.now()}`);
  fs.renameSync(dirPath, target);
  invalidateLibraryCache();
  const all = loadAntibodies();
  saveAntibodyIndex(buildAntibodyIndex(all));
  self.showSystemMessage(
    `${C.green}✅ Antibody "${id}" moved to ${C.reset}antibodies/.trash/ (recoverable).`,
  );
}

export async function doAntigenShow(self: TUIHost, id: string): Promise<void> {
  const antigens = loadAntigens();
  const ag = antigens.find((a) => a.config.id === id);
  if (!ag) { self.showSystemMessage(`Antigen "${id}" not found.`); return; }
  let out = `${C.bold}Antigen: ${ag.config.name}${C.reset} [${ag.config.id}]\n`;
  out += `Category: ${ag.config.category}\n`;
  out += `Injection: ${ag.config.injection_point}\n`;
  if (ag.payload) {
    out += `\nPayload:\n${ag.payload.slice(0, 500)}${ag.payload.length > 500 ? "..." : ""}`;
  }
  self.showSystemMessage(out);
}

export async function doVaccinate(self: TUIHost, pattern: string): Promise<void> {
  const config = loadEvolutionConfig();
  const engine = new EvolutionEngine({
    config,
    generatorLlm: self.llmCall,
    reviewerLlm: self.llmCall,
  });
  const clusterId = buildClusterId(pattern);
  const benign = loadHistory()
    .filter((h) => h.verdict === "benign")
    .slice(0, config.benignSamples)
    .map((h) => h.content_preview);

  self.showSystemMessage(`${C.cyan}💉 Running immune System 2 loop...${C.reset}`);

  try {
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
    if (loop.approved.length === 0) {
      self.showSystemMessage(
        `${C.yellow}Vaccination finished: ${loop.termination} (${loop.rounds} rounds). No antibody accepted.${C.reset}`,
      );
      return;
    }

    const names = loop.approved.map((vc) => vc.draft.name).join(", ");
    const shadowNote =
      outcome.shadowStarted.length > 0
        ? ` Shadow observation: ${outcome.shadowStarted.join(", ")}`
        : "";
    self.showSystemMessage(
      `${C.green}💉 Vaccination complete:${C.reset} ${loop.approved.length} antibody(s) — ${names}${shadowNote}`,
    );
    self.refreshFooter();
  } catch (err) {
    self.showSystemMessage(`${C.red}❌ Vaccination failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Session Commands ──────────────────────────────────────────────

export async function doNewSession(self: TUIHost): Promise<void> {
  const newMgr = SessionManager.create(process.cwd());
  self.showSystemMessage(`${C.green}New session:${C.reset} ${newMgr.getSessionId()}`);
  self.showSystemMessage(`${C.dim}Restart CAITLYN to begin the new session.${C.reset}`);
}

export async function doResumeSession(self: TUIHost): Promise<void> {
  const sessions = SessionManager.list(process.cwd());
  if (sessions.length === 0) {
    self.showSystemMessage("No saved sessions found.");
    return;
  }
  self.tui.showOverlay(buildSessionPickerOverlay(sessions), { anchor: "center", width: "70%", maxHeight: "70%" });
}

export async function doSessionInfo(self: TUIHost): Promise<void> {
  const mgr = self.sessionMgr;
  const stats = mgr.getTokenStats();
  const name = mgr.getSessionName();

  const row = (k: string, v: string) =>
    ` ${fg(PAL.faint)}${k.padEnd(8)}${C.reset}${fg(PAL.text)}${v}${C.reset}`;
  let out = `${gradText("SESSION INFO", PAL.cyan, PAL.violet, true)}\n`;
  out += row("ID", mgr.getSessionId()) + "\n";
  out += row("FILE", mgr.getSessionFile()) + "\n";
  out += row("ENTRIES", String(mgr.getEntryCount())) + "\n";
  if (name) out += row("NAME", name) + "\n";
  out += row("TOKENS", `↑${stats.input} ↓${stats.output}`) + "\n";
  if (stats.cost > 0) out += row("COST", `$${stats.cost.toFixed(4)}`) + "\n";
  out += row("CWD", mgr.getCwd()) + "\n";

  self.showSystemMessage(out);
}

export async function doCompaction(self: TUIHost): Promise<void> {
  const entries = self.sessionMgr.getAllEntries();
  const msgs = entries.filter((e) => e.type === "message") as MessageEntry[];
  if (msgs.length < 4) {
    self.showSystemMessage("Not enough messages to compact (need at least 4).");
    return;
  }

  // Simple: keep last 50% of messages, summarize the rest
  const cutIndex = Math.floor(msgs.length / 2);
  const oldMsgs = msgs.slice(0, cutIndex);
  const firstKeptId = msgs[cutIndex].id;

  const summaryText = oldMsgs
    .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
    .join("\n");
  const lastSummarizedId = msgs[cutIndex - 1].id;

  // Use LLM to summarize if available
  let summary = "";
  try {
    const prompt = `Summarize this conversation history concisely (2-3 sentences), preserving key facts and decisions:\n\n${summaryText}`;
    summary = await self.llmCall("You are a summarizer. Be concise.", prompt);
  } catch {
    summary = `[Conversation history condensed — ${oldMsgs.length} earlier messages summarized]`;
  }

  const tokensBefore = oldMsgs.reduce(
    (sum, m) => sum + estimateTokens(m.content), 0,
  );

  // Insert the compaction boundary after the summarized messages so the
  // kept half stays in the LLM context (append-at-end would drop it).
  self.sessionMgr.insertCompactionAfter(lastSummarizedId, summary, firstKeptId, tokensBefore);
  self.sessionMgr.flush();
  self.showSystemMessage(
    `${C.green}Compacted.${C.reset} Summarized ${oldMsgs.length} messages (≈${tokensBefore} tokens).`,
  );
}

export function showSessionTree(self: TUIHost): void {
  const tree = self.sessionMgr.getTree();
  function formatNode(node: typeof tree[0], depth: number): string {
    const e = node.entry;
    const indent = "  ".repeat(depth);
    let line = `${indent}${e.type}: ${e.id.slice(0, 8)}`;
    if (e.type === "message") {
      line += ` [${(e as MessageEntry).role}]`;
    } else if (e.type === "session_info") {
      line += ` "${(e as SessionInfoEntry).name}"`;
    }
    return [line, ...node.children.flatMap((c) => formatNode(c, depth + 1))].join("\n");
  }

  const lines = tree.map((n) => formatNode(n, 0)).join("\n");
  self.showSystemMessage(
    `${C.bold}Session Tree:${C.reset}\n${lines || "(empty)"}`,
  );
}

export function doFork(self: TUIHost, messageId: string): void {
  try {
    const newPath = self.sessionMgr.createBranchedSession(messageId);
    self.showSystemMessage(
      `${C.green}Forked session created:${C.reset} ${newPath}`,
    );
  } catch (err) {
    self.showSystemMessage(`${C.red}Fork failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function doClone(self: TUIHost): void {
  const cloned = SessionManager.forkFrom(
    self.sessionMgr.getSessionFile(),
    process.cwd(),
  );
  self.showSystemMessage(`${C.green}Cloned session:${C.reset} ${cloned.getSessionFile()}`);
}

export function doDelete(self: TUIHost): void {
  const file = self.sessionMgr.getSessionFile();
  const items = [
    { value: "yes", label: `${C.red}Yes, delete session${C.reset}` },
    { value: "no", label: "No, keep session" },
  ];
  const list = new SelectList(items, 2, selectListTheme);
  const confirmText = new Text(`${C.yellow}Delete session?${C.reset}\n${C.dim}${file}${C.reset}`);
  const container = new Container();
  container.addChild(confirmText);
  container.addChild(list);
  const handle = self.tui.showOverlay(container, { anchor: "center", width: "60%", maxHeight: "30%" });
  list.onSelect = (item) => {
    handle.hide();
    if (item.value === "yes") {
      self.sessionMgr.delete();
      self.showSystemMessage(`${C.yellow}Session deleted:${C.reset} ${file}`);
    }
  };
  list.onCancel = () => {
    handle.hide();
  };
}

export async function doModelSwitch(self: TUIHost, args: string): Promise<void> {
  const parts = args.split("/");
  if (parts.length < 2) {
    self.showSystemMessage("Usage: /model <provider/model>  (e.g., /model openrouter/deepseek/deepseek-chat)");
    return;
  }
  const provider = parts[0];
  const modelId = parts.slice(1).join("/");

  // Verify provider exists
  const foundProvider = getProviders().find((p) => p === provider);
  if (!foundProvider) {
    const available = getProviders().join(", ");
    self.showSystemMessage(
      `${C.red}Unknown provider "${provider}".${C.reset} Available: ${available}`,
    );
    return;
  }

  // Verify models are available for this provider
  const models = getModels(foundProvider);
  if (models.length === 0) {
    self.showSystemMessage(
      `${C.red}No models available for provider "${provider}".${C.reset} Check your API key configuration.`,
    );
    return;
  }

  // Verify the specific model exists
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    const available = models.map((m) => m.id).join(", ");
    self.showSystemMessage(
      `${C.red}Model "${modelId}" not found for "${provider}".${C.reset} Available: ${available}`,
    );
    return;
  }

  self.currentProvider = provider;
  self.currentModelId = modelId;
  self.sessionMgr.appendModelChange(provider, modelId);
  self.sessionMgr.flush();
  self.footer.update({
    currentModel: getModelDisplay(provider, modelId),
    providerName: provider,
  });

  // Update agent model if available
  if (self.agent) {
    self.agent.state.model = model;
  }

  self.showSystemMessage(`${C.green}Model switched to:${C.reset} ${provider}/${modelId}`);
}

export async function doLogin(self: TUIHost, argLine: string): Promise<void> {
  const parts = argLine.trim().split(/\s+/).filter(Boolean);
  const provider = parts[0];
  const apiKey = parts.slice(1).join(" ").trim();
  if (!provider) {
    const configured = listConfiguredProviders();
    if (configured.length === 0) {
      self.showSystemMessage(
        "No providers configured. Set API keys via environment variables.\n" +
        "  export OPENROUTER_API_KEY=sk-...\n" +
        "  export OPENAI_API_KEY=sk-...\n" +
        "  etc.",
      );
    } else {
      self.showSystemMessage(`Configured providers: ${configured.join(", ")}`);
    }
    return;
  }
  if (!apiKey) {
    self.showSystemMessage(
      `Usage: /login <provider> <api-key>\n` +
      `  e.g. /login deepseek sk-...\n` +
      `The key is persisted to ~/.caitlyn/auth.json (0600).`,
    );
    return;
  }
  persistApiKey(provider, apiKey);
  self.showSystemMessage(
    `${C.green}✅ API key saved for ${provider}${C.reset} (persisted to ~/.caitlyn/auth.json)`,
  );
}

export function showHelp(self: TUIHost): void {
  const section = (title: string) => ` ${gradText(title, PAL.cyan, PAL.violet, true)} `;
  const lines = [
    `${paint(" ◈ ", PAL.cyan, PAL.cyanBg, true)} ${gradText("CAITLYN COMMANDS", PAL.cyan, PAL.magenta, true)}`,
    ``,
    section("SCANNING & DEFENSE"),
    `  /scan <content>      Security scan for injection attacks`,
    `  /status              Immune library status`,
    `  /dashboard           Defense telemetry dashboard`,
    `  /guard               Agent protection & watch status`,
    `  /history             Recent scan history`,
    `  /antibody list       List antibody forest`,
    `  /antigen <id>        Show antigen details`,
    `  /vaccinate <pattern> Evolve antibody`,
    ``,
    `${fg(PAL.faint)}Ctrl+G guard status · Ctrl+D dashboard · Ctrl+S status · Ctrl+H history · Ctrl+P model${C.reset}`,
    section("SESSION"),
    `  /new                 Start new session`,
    `  /resume              Open session picker`,
    `  /session             Show session info`,
    `  /name <title>        Set session name`,
    `  /export [path]       Export session`,
    `  /compact             Compact context`,
    `  /tree                View session tree`,
    `  /fork <id>           Branch from message`,
    `  /clone               Duplicate session`,
    `  /delete              Delete session`,
    ``,
    section("CONFIG"),
    `  /model [provider/id] Switch LLM model`,
    `  /thinking <level>    off|low|medium|high`,
    `  /login [provider]    Configure auth`,
    `  /settings            Open settings`,
    ``,
    section("META"),
    `  /help                Show this help`,
    `  /clear               Clear screen`,
    `  /quit                Exit CAITLYN`,
    ``,
    `${fg(PAL.faint)}!<content>  quick scan alias${C.reset}`,
    ``,
    `${fg(PAL.faint)}Ctrl+C quit  ·  Esc back/abort  ·  Tab back  ·  q dismiss${C.reset}`,
  ];

  self.showSystemMessage(lines.join("\n"));
}
