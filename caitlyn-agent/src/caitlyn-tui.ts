/**
 * CAITLYN Agent — Terminal UI (Upgraded)
 *
 * Architecture (pi coding agent pattern):
 *   tui.children (top → bottom):
 *     [0] Text(logo)
 *     [1..n-2] user/assistant/tool Markdown + Loader
 *     [n-1] FooterComponent (2-line status)
 *     [n]   Editor (ALWAYS last child)
 *
 * On submit: splice user Markdown before Editor, insert Loader
 * On agent event: replace Loader with streaming Markdown
 * On agent_end: remove Loader, finalize, enable input
 *
 * Usage:
 *   const tui = CaitlynTUI.create(llmCall, agent, sessionManager);
 *   await tui.run();
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  TUI,
  Container,
  Markdown,
  Text,
  Box,
  SelectList,
  ProcessTerminal,
  CancellableLoader,
  Loader,
  Editor,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type LlmCallFn } from "./scanner.js";
import { hybridScan, getCaitlyndStatus, isCaitlyndAvailable } from "./hybrid-scanner.js";
import { getDashboard, loadHistory } from "./history.js";
import {
  loadAntibodies,
  loadAntigens,
  loadAntibodyIndex,
  buildAntibodyIndex,
} from "./library.js";
import type { ScriptResult } from "./schema.js";
import { CaitlyndClient } from "./caitlynd-client.js";
import { SessionManager } from "./session/session-manager.js";
import {
  FooterComponent,
  createDefaultFooterData,
  type FooterData,
} from "./components/footer.js";
import { createAutocompleteProvider } from "./commands/slash-commands.js";
import { getContextWindow, getModelDisplay } from "./config/models.js";
import { listConfiguredProviders } from "./config/credentials.js";
import { getProviders, getModels } from "./llm.js";
import type { MessageEntry } from "./session/session-types.js";

// ── ANSI Helpers ──────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  bgRed:   "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgCyan:  "\x1b[46m",
} as const;

const noEmoji = process.env.CAITLYN_NO_EMOJI === "1";

// ── Logo ──────────────────────────────────────────────────────────

const CAITLYN_LOGO = [
  `${C.cyan}${C.bold}🛡️  C A I T L Y N${C.reset}`,
  `${C.dim}AI Agent Immune System${C.reset}`,
  `${C.cyan}${"─".repeat(56)}${C.reset}`,
  `${C.dim}Continuous Agents for Injection Threats${C.reset}`,
  `${C.dim}via Lifelong Yielding Nexus${C.reset}`,
].join("\n");

// ── Theme ─────────────────────────────────────────────────────────

const THEME: MarkdownTheme = {
  heading: (text) => `${C.bold}${C.cyan}${text}${C.reset}`,
  bold: (text) => `${C.bold}${text}${C.reset}`,
  italic: (text) => `${C.dim}${text}${C.reset}`,
  strikethrough: (text) => `${C.dim}${text}${C.reset}`,
  underline: (text) => `${C.cyan}${text}${C.reset}`,
  code: (text) => `${C.yellow}${text}${C.reset}`,
  codeBlock: (text) => `${text}`,
  codeBlockBorder: (text) => `${C.dim}${text}${C.reset}`,
  quote: (text) => text,
  quoteBorder: (text) => `${C.dim}${text}${C.reset}`,
  link: (text) => `${C.blue}${text}${C.reset}`,
  linkUrl: (text) => `${C.dim}${text}${C.reset}`,
  listBullet: (text) => `${C.cyan}${text}${C.reset}`,
  hr: (_) => `${C.dim}${"-".repeat(72)}${C.reset}`,
};

// ── LLM Error Translation ─────────────────────────────────────────

function translateLlmError(err: Error): string {
  const msg = err.message;
  if (msg.includes("401") || msg.includes("Unauthorized")) return "Authentication failed. Check your API key.";
  if (msg.includes("429") || msg.includes("rate")) return "Rate limited. Wait and try again.";
  if (msg.includes("context_length") || msg.includes("too long")) return "Input too long. Try /compact or use a shorter message.";
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) return "Cannot reach LLM provider. Check your network.";
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) return "LLM request timed out. Try again.";
  if (msg.includes("insufficient_quota")) return "API quota exceeded. Check your billing.";
  return msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
}

// ── Git Branch Detection ──────────────────────────────────────────

function getGitBranch(cwd: string): string | undefined {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, timeout: 2000, encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch { /* ignore */ }
  return undefined;
}

// ── Token Estimation ──────────────────────────────────────────────

/** Rough token count (4 chars approx 1 token for English, 1 char approx 1 token for CJK). */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp && cp > 0x2000) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
    if (cp && cp > 0xffff) i++;
  }
  return Math.ceil(tokens);
}

// ── Default SelectList Theme ──────────────────────────────────────

const selectListTheme = {
  selectedPrefix: (text: string) => `${C.cyan}${text}${C.reset}`,
  selectedText: (text: string) => `${C.bold}${text}${C.reset}`,
  description: (text: string) => `${C.dim}${text}${C.reset}`,
  scrollInfo: (text: string) => `${C.dim}${text}${C.reset}`,
  noMatch: (text: string) => `${C.dim}${text}${C.reset}`,
};

// ── Overlay Helpers ───────────────────────────────────────────────

function makeBox(title: string, lines: string[], maxHeight = 20): Box {
  const box = new Box(1, 1);
  let allLines: string[];
  if (lines.length > maxHeight) {
    allLines = [`${C.bold}${C.cyan}${title}${C.reset}`, "", ...lines.slice(0, maxHeight - 3), `${C.dim}(scroll for more)${C.reset}`];
  } else {
    allLines = [`${C.bold}${C.cyan}${title}${C.reset}`, "", ...lines];
  }
  box.addChild(new Text(allLines.join("\n")));
  return box;
}

function buildDashboardOverlay(): Component {
  const stats = getDashboard();
  if (stats.total_scans === 0) {
    return makeBox("CAITLYN Dashboard", ["No scan data yet."]);
  }

  const lines = [
    `${C.bold}Total Scans:${C.reset}      ${stats.total_scans}`,
    `${C.bold}Detected:${C.reset}        ${stats.malicious_count}`,
    `${C.bold}Clean:${C.reset}           ${stats.benign_count}`,
    `${C.bold}Detection Rate:${C.reset}   ${(stats.detection_rate * 100).toFixed(1)}%`,
    "",
    `${C.bold}Avg Latency:${C.reset}      ${stats.avg_latency_ms.toFixed(2)}ms`,
    `${C.bold}Avg Tokens:${C.reset}       ${stats.avg_tokens.toFixed(1)}`,
    `${C.bold}Total Tokens:${C.reset}     ${stats.total_tokens}`,
    `${C.bold}Tier 0 Hits:${C.reset}      ${stats.tier0_hits}`,
    `${C.bold}Tier 1 Hits:${C.reset}      ${stats.tier1_hits}`,
  ];

  if (stats.top_antibodies.length > 0) {
    lines.push("", `${C.bold}Top Antibodies:${C.reset}`);
    for (const a of stats.top_antibodies.slice(0, 5)) {
      lines.push(`  ${a.id}: ${a.hits} hits`);
    }
  }

  return makeBox("CAITLYN Dashboard", lines);
}

function buildStatusOverlay(): Component {
  const antibodies = loadAntibodies();
  const antigens = loadAntigens();
  const index = loadAntibodyIndex() ?? buildAntibodyIndex(antibodies);

  const lines: string[] = [];
  lines.push(`${antibodies.length} antibodies, ${antigens.length} antigens`);
  lines.push("");
  lines.push(`${C.bold}Antibodies:${C.reset}`);

  for (const rid of index.roots) {
    const ab = antibodies.find((a) => a.config.id === rid);
    if (ab) {
      const tp = ab.config.stats?.true_positives ?? 0;
      const fp = ab.config.stats?.false_positives ?? 0;
      lines.push(`  ${ab.config.id} [${ab.config.category}] T${ab.config.tier} TP=${tp} FP=${fp}`);
    }
  }

  if (index.roots.length === 0) {
    lines.push(`  (none loaded)`);
  }

  lines.push("");
  lines.push(`${C.bold}Antigens by Category:${C.reset}`);
  const byCat: Record<string, number> = {};
  for (const ag of antigens) byCat[ag.config.category] = (byCat[ag.config.category] || 0) + 1;
  for (const [cat, count] of Object.entries(byCat)) {
    lines.push(`  ${cat}: ${count}`);
  }

  return makeBox("CAITLYN Library", lines);
}

function buildHistoryOverlay(): Component {
  const entries = loadHistory();
  if (entries.length === 0) {
    return makeBox("Scan History", ["No scan history yet."]);
  }

  const items = entries.map((e) => {
    const emoji = e.verdict === "malicious" ? "🚨"
      : e.verdict === "suspicious" ? "⚠️" : "✅";
    const label = `${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} | T${e.tier} | ${e.content_preview}`;
    return { value: e.timestamp, label };
  });

  const list = new SelectList(items, 10, selectListTheme);
  return list;
}

function buildSessionPickerOverlay(
  sessions: Array<{ id: string; name?: string; entryCount: number; updatedAt: number }>,
): Component {
  if (sessions.length === 0) {
    return makeBox("Sessions", ["No saved sessions found."]);
  }

  const items = sessions.map((s) => {
    const date = new Date(s.updatedAt).toLocaleString();
    const label = s.name || s.id.slice(0, 20);
    return {
      value: s.id,
      label: `${label}  ${C.dim}(${s.entryCount} msgs, ${date})${C.reset}`,
    };
  });

  const list = new SelectList(items, 8, selectListTheme);
  return list;
}

function buildModelSelectorOverlay(): Component {
  const items: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();

  for (const p of getProviders()) {
    try {
      for (const m of getModels(p)) {
        const key = `${p}/${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const display = getModelDisplay(p, m.id);
        const ctx = getContextWindow(p, m.id);
        const ctxLabel = ctx >= 1000 ? `${Math.round(ctx / 1000)}k ctx` : `${ctx} ctx`;
        items.push({
          value: key,
          label: `${display}  ${C.dim}(${p})  ${ctxLabel}${C.reset}`,
        });
      }
    } catch { /* skip */ }
  }

  if (items.length === 0) {
    return makeBox("Model Selector", [
      "No models configured.",
      "",
      "Set API keys via environment variables or /login <provider>",
    ]);
  }

  const list = new SelectList(items, 10, selectListTheme);
  return list;
}

// ── Main TUI ──────────────────────────────────────────────────────

export class CaitlynTUI {
  private tui: TUI;
  private editor: Editor;
  private footer: FooterComponent;
  private agent: Agent | null = null;
  private llmCall: LlmCallFn;
  private sessionMgr: SessionManager;
  private running = false;
  private isResponding = false;
  private commandHistory: string[] = [];
  private historyIndex = -1;
  private currentProvider: string;
  private currentModelId: string;
  private footerTimer: ReturnType<typeof setInterval> | null = null;
  private currentLoader: CancellableLoader | null = null;
  private sigintHandler: (() => void) | null = null;
  private rejectionHandler: ((reason: unknown) => void) | null = null;

  private constructor(
    tui: TUI,
    editor: Editor,
    footer: FooterComponent,
    agent: Agent | null,
    llmCall: LlmCallFn,
    sessionMgr: SessionManager,
    provider: string,
    modelId: string,
  ) {
    this.tui = tui;
    this.editor = editor;
    this.footer = footer;
    this.agent = agent;
    this.llmCall = llmCall;
    this.sessionMgr = sessionMgr;
    this.currentProvider = provider;
    this.currentModelId = modelId;
  }

  static async create(
    llmCall: LlmCallFn,
    agent: Agent | null,
    sessionMgr?: SessionManager,
  ): Promise<CaitlynTUI> {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    tui.setClearOnShrink(false);

    const cwd = process.cwd();
    const mgr = sessionMgr ?? SessionManager.continueRecent(cwd);
    const provider = process.env.CAITLYN_PROVIDER ?? "openrouter";
    const modelId = process.env.CAITLYN_MODEL ?? "deepseek/deepseek-chat";

    // Add logo
    const header = new Text(
      noEmoji ? "CAITLYN — AI Agent Immune System" : CAITLYN_LOGO,
    );
    tui.addChild(header);

    // Create footer
    const footerData = createDefaultFooterData(cwd);
    const stats = mgr.getTokenStats();
    footerData.totalInput = stats.input;
    footerData.totalOutput = stats.output;
    footerData.totalCost = stats.cost;
    footerData.currentModel = getModelDisplay(provider, modelId);
    footerData.providerName = provider;
    footerData.sessionName = mgr.getSessionName();
    footerData.antibodyCount = loadAntibodies().length;
    footerData.gitBranch = getGitBranch(cwd);

    const daemonAvailable = await isCaitlyndAvailable();
    footerData.daemonStatus = daemonAvailable ? "connected" : "disconnected";

    const footer = new FooterComponent(footerData);
    tui.addChild(footer);

    // Create editor with autocomplete
    const editor = new Editor(tui, {
      borderColor: (s: string) => `${C.dim}${s}${C.reset}`,
      selectList: selectListTheme,
    }, { paddingX: 1 });

    editor.setAutocompleteProvider(createAutocompleteProvider());
    tui.addChild(editor);
    tui.setFocus(editor);

    const self = new CaitlynTUI(
      tui, editor, footer, agent ?? null, llmCall, mgr, provider, modelId,
    );

    // Wire editor submit
    editor.onSubmit = async (value: string) => {
      await self.handleSubmit(value);
    };

    // Global input listeners for keyboard shortcuts
    // NOTE: Global listeners fire BEFORE the focused component's handleInput,
    // so we must be careful not to steal editing keys from the Editor.
    tui.addInputListener((data: string) => {
      // ── Overlay dismissal keys (always available) ────────────
      // Esc: universal dismiss / abort
      if (data === "\x1b") {
        if (tui.hasOverlay()) {
          tui.hideOverlay();
          return { consume: true };
        }
        // No overlay: Esc aborts ongoing response
        if (self.isResponding) {
          self.abortResponse();
          return { consume: true };
        }
      }
      // Tab: dismiss overlay or focus editor
      if (data === "\t" || data === "\x09") {
        if (tui.hasOverlay()) {
          tui.hideOverlay();
          return { consume: true };
        }
        return { consume: true }; // Always consume Tab
      }
      // q: dismiss display overlay (non-interactive overlays only)
      if (data === "q" && tui.hasOverlay()) {
        tui.hideOverlay();
        return { consume: true };
      }
      // ── Global always-available ──────────────────────────────
      // Ctrl+C: always quit
      if (data === "\x03") {
        self.stop();
        return { consume: true };
      }
      // Ctrl+L: always clear screen
      if (data === "\x0c") {
        const children = tui.children;
        children.splice(1, children.length - 3);
        tui.requestRender();
        return { consume: true };
      }
      // ── Quick-launch overlays (only when NO overlay active) ──
      if (!tui.hasOverlay() && (self.isResponding || self.editor.disableSubmit)) {
        if (data === "\x04") {
          tui.showOverlay(buildDashboardOverlay(), {
            anchor: "center", width: "70%", maxHeight: "70%",
          });
          return { consume: true };
        }
        if (data === "\x13") {
          tui.showOverlay(buildStatusOverlay(), {
            anchor: "center", width: "70%", maxHeight: "70%",
          });
          return { consume: true };
        }
        if (data === "\x08") {
          tui.showOverlay(buildHistoryOverlay(), {
            anchor: "center", width: "70%", maxHeight: "70%",
          });
          return { consume: true };
        }
        if (data === "\x10") {
          tui.showOverlay(buildModelSelectorOverlay(), {
            anchor: "center", width: "70%", maxHeight: "70%",
          });
          return { consume: true };
        }
      }
      return undefined;
    });

    // Wire agent listener if agent exists
    if (agent) {
      self.wireAgentListener(agent);
    }

    return self;
  }

  private wireAgentListener(agent: Agent): void {
    let currentMessageContent = "";

    agent.subscribe((event) => {
      if (!this.running) return;

      switch (event.type) {
        case "agent_start": {
          currentMessageContent = "";
          break;
        }
        case "message_update": {
          if (event.message.role !== "assistant") break;
          const blocks = event.message.content;
          const text = (Array.isArray(blocks) ? blocks : [])
            .filter((c) => c.type === "text")
            .map((c) => (c as { type: "text"; text: string }).text)
            .join("");
          currentMessageContent = text;

          if (this.currentLoader) {
            this.tui.removeChild(this.currentLoader);
            this.currentLoader = null;
          }
          this.updateStreamingMessage(text);
          this.tui.requestRender();
          break;
        }
        case "tool_execution_start": {
          const toolLine = `${C.dim}⚙ ${event.toolName}${C.reset}`;
          this.insertBeforeEditor(new Text(toolLine));
          break;
        }
        case "tool_execution_end": {
          if (event.result) {
            const resultText = typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
            const preview = resultText.length > 300
              ? resultText.slice(0, 297) + "..."
              : resultText;
            this.insertBeforeEditor(new Text(`${C.dim}  → ${preview}${C.reset}`));
          }
          break;
        }
        case "message_end": {
          if (this.currentLoader) {
            this.tui.removeChild(this.currentLoader);
            this.currentLoader = null;
          }

          const prefix = `${C.bold}${C.cyan}CAITLYN${C.reset}  ${C.dim}just now${C.reset}  `;
          const msgMd = new Markdown(prefix + currentMessageContent, 0, 0, THEME);
          this.insertBeforeEditor(msgMd);

          if (event.message.role === "assistant") {
            const usage = event.message.usage;
            this.sessionMgr.appendMessage({
              role: "assistant",
              content: currentMessageContent,
              usage: usage
                ? {
                    input: usage.input ?? 0,
                    output: usage.output ?? 0,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    cost: usage.cost.total,
                  }
                : undefined,
            });
          } else {
            this.sessionMgr.appendMessage({
              role: "assistant",
              content: currentMessageContent,
            });
          }
          this.sessionMgr.flush();

          this.refreshFooter();
          currentMessageContent = "";
          this.maybeCompact();

          this.isResponding = false;
          this.editor.disableSubmit = false;
          this.tui.setFocus(this.editor);
          this.tui.requestRender();
          break;
        }
        case "agent_end": {
          if (this.currentLoader) {
            this.tui.removeChild(this.currentLoader);
            this.currentLoader = null;
          }
          this.isResponding = false;
          this.editor.disableSubmit = false;
          this.tui.setFocus(this.editor);
          this.tui.requestRender();
          break;
        }
      }
    });
  }

  private streamingMd: Markdown | null = null;

  private updateStreamingMessage(text: string): void {
    const prefix = `${C.bold}${C.cyan}CAITLYN${C.reset}  ${C.dim}streaming...${C.reset}  `;
    if (this.streamingMd) {
      // Remove and re-add (Markdown doesn't support in-place update)
      this.tui.removeChild(this.streamingMd);
    }
    this.streamingMd = new Markdown(prefix + text, 0, 0, THEME);
    this.insertBeforeEditor(this.streamingMd);
  }

  private insertBeforeEditor(component: Component): void {
    const children = this.tui.children;
    children.splice(children.length - 1, 0, component);
  }

  private insertBeforeFooter(component: Component): void {
    const children = this.tui.children;
    // Footer is at index length-2, editor at length-1
    children.splice(children.length - 2, 0, component);
  }

  // ── Submit Handler ───────────────────────────────────────────

  async handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (this.isResponding) return;

    // History tracking
    if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== trimmed) {
      this.commandHistory.push(trimmed);
      if (this.commandHistory.length > 100) this.commandHistory.shift();
    }
    this.historyIndex = this.commandHistory.length;

    if (trimmed.startsWith("/")) {
      await this.handleSlashCommand(trimmed);
    } else if (trimmed.startsWith("!")) {
      await this.handleBangCommand(trimmed);
    } else {
      await this.handleChat(trimmed);
    }

    this.tui.requestRender();
  }

  // ── Slash Commands ───────────────────────────────────────────

  private async handleSlashCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const args = parts.slice(1).join(" ");
    const verb = parts[0].toLowerCase();

    switch (verb) {
      // ── Scanning & Defense ─────────────────────────────────
      case "/scan": {
        if (!args) { this.showSystemMessage("Usage: /scan <content>"); return; }
        await this.doScan(args);
        break;
      }
      case "/status": {
        this.tui.showOverlay(buildStatusOverlay(), { anchor: "center", width: "70%", maxHeight: "70%" });
        break;
      }
      case "/dashboard": {
        this.tui.showOverlay(buildDashboardOverlay(), { anchor: "center", width: "70%", maxHeight: "70%" });
        break;
      }
      case "/history": {
        this.tui.showOverlay(buildHistoryOverlay(), { anchor: "center", width: "70%", maxHeight: "70%" });
        break;
      }

      // ── Antibody Management ────────────────────────────────
      case "/antibody": {
        const subCmd = parts[1]?.toLowerCase();
        const abId = parts[2];
        if (subCmd === "list") { await this.doAntibodyList(); }
        else if (subCmd === "add" && abId) { await this.doAntibodyAdd(abId); }
        else if (subCmd === "remove" && abId) { await this.doAntibodyRemove(abId); }
        else { this.showSystemMessage("Usage: /antibody list | add <id> | remove <id>"); }
        break;
      }
      case "/antigen": {
        if (!args) { this.showSystemMessage("Usage: /antigen <id>"); return; }
        await this.doAntigenShow(args.trim());
        break;
      }
      case "/vaccinate": {
        if (!args) { this.showSystemMessage("Usage: /vaccinate <pattern>"); return; }
        await this.doVaccinate(args);
        break;
      }

      // ── Session ────────────────────────────────────────────
      case "/new": {
        await this.doNewSession();
        break;
      }
      case "/resume": {
        await this.doResumeSession();
        break;
      }
      case "/session": {
        await this.doSessionInfo();
        break;
      }
      case "/name": {
        if (!args) { this.showSystemMessage("Usage: /name <title>"); return; }
        this.sessionMgr.appendSessionInfo(args);
        this.sessionMgr.flush();
        this.footer.update({ sessionName: args });
        this.showSystemMessage(`${C.green}Session named:${C.reset} ${args}`);
        break;
      }
      case "/export": {
        const outPath = args || `./caitlyn-session-${this.sessionMgr.getSessionId()}.jsonl`;
        fs.copyFileSync(this.sessionMgr.getSessionFile(), outPath);
        this.showSystemMessage(`${C.green}Exported to:${C.reset} ${outPath}`);
        break;
      }
      case "/compact": {
        await this.doCompaction();
        break;
      }
      case "/tree": {
        this.showSessionTree();
        break;
      }
      case "/fork": {
        if (!args) { this.showSystemMessage("Usage: /fork <message-id>"); return; }
        this.doFork(args);
        break;
      }
      case "/clone": {
        this.doClone();
        break;
      }
      case "/delete": {
        this.doDelete();
        break;
      }

      // ── Config ─────────────────────────────────────────────
      case "/model": {
        if (args) {
          await this.doModelSwitch(args);
        } else {
          this.tui.showOverlay(buildModelSelectorOverlay(), { anchor: "center", width: "70%", maxHeight: "70%" });
        }
        break;
      }
      case "/thinking": {
        if (!args) { this.showSystemMessage("Usage: /thinking off|low|medium|high"); return; }
        const level = args as "off" | "low" | "medium" | "high";
        if (!["off", "low", "medium", "high"].includes(level)) {
          this.showSystemMessage("Thinking level must be: off, low, medium, or high");
          return;
        }
        this.sessionMgr.appendThinkingLevelChange(level);
        this.sessionMgr.flush();
        this.footer.update({ thinkingLevel: level });
        this.showSystemMessage(`${C.cyan}Thinking:${C.reset} ${level}`);
        break;
      }
      case "/login": {
        await this.doLogin(args);
        break;
      }
      case "/settings": {
        this.showSystemMessage("Settings: ~/.caitlyn/config.toml (edit manually)");
        break;
      }

      // ── Meta ────────────────────────────────────────────────
      case "/help": {
        this.showHelp();
        break;
      }
      case "/quit":
      case "/exit": {
        this.showSystemMessage("Goodbye. Stay secure.");
        this.stop();
        break;
      }
      case "/clear": {
        // Remove all message components between header and footer
        const children = this.tui.children;
        // Keep header (index 0), footer/editor are last 2
        children.splice(1, children.length - 3);
        this.tui.requestRender();
        break;
      }
      default: {
        this.showSystemMessage(`Unknown command: ${verb}. Type /help for commands.`);
      }
    }
  }

  private async handleBangCommand(cmd: string): Promise<void> {
    const content = cmd.slice(1).trim();
    if (!content) { this.showSystemMessage("Usage: !<content> — quick security scan"); return; }
    await this.doScan(content);
  }

  private async handleChat(message: string): Promise<void> {
    if (!this.agent) {
      this.showSystemMessage(
        `${C.yellow}Agent not available.${C.reset} Use ${C.cyan}/scan <content>${C.reset} for security scanning.`,
      );
      return;
    }

    this.isResponding = true;
    this.editor.disableSubmit = true;

    // Add user message
    const prefix = `${C.bold}${C.green}You${C.reset}  ${C.dim}just now${C.reset}  `;
    const userMd = new Markdown(prefix + message, 0, 0, THEME);
    this.insertBeforeEditor(userMd);

    // Record in session
    this.sessionMgr.appendMessage({ role: "user", content: message });
    this.sessionMgr.flush();

    // Show loader
    const loader = new CancellableLoader(
      this.tui,
      (s) => `${C.cyan}${s}${C.reset}`,
      (s) => `${C.dim}${s}${C.reset}`,
      "Thinking...",
    );
    this.currentLoader = loader;
    this.streamingMd = null;

    loader.onAbort = () => {
      this.agent?.abort?.();
      this.showSystemMessage(`${C.yellow}Aborted.${C.reset}`);
      this.isResponding = false;
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
    };

    this.insertBeforeEditor(loader);
    this.tui.requestRender();

    try {
      await this.agent.prompt(message);
    } catch (err) {
      if (this.currentLoader) {
        this.tui.removeChild(this.currentLoader);
        this.currentLoader = null;
      }
      const friendly = translateLlmError(err instanceof Error ? err : new Error(String(err)));
      this.showSystemMessage(`${C.red}Agent error:${C.reset} ${friendly}`);
      this.isResponding = false;
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    }
  }

  // ── Scan ────────────────────────────────────────────────────

  private async doScan(content: string): Promise<void> {
    this.showSystemMessage(`${C.cyan}⊕ Scanning (${content.length} chars)...${C.reset}`);

    try {
      const result = await hybridScan({ content, llmCall: this.llmCall });

      const verdict = result.verdict.toUpperCase();
      let emoji: string;
      let color: string;
      let bgColor: string;
      if (verdict === "MALICIOUS") {
        emoji = "🚨"; color = C.red; bgColor = "\x1b[41m\x1b[37m";
      } else if (verdict === "SUSPICIOUS") {
        emoji = "⚠️"; color = C.yellow; bgColor = "\x1b[43m\x1b[30m";
      } else {
        emoji = "✅"; color = C.green; bgColor = "\x1b[42m\x1b[37m";
      }

      let output = `${bgColor} ${emoji}  ${verdict}  ${emoji} ${C.reset}`;
      output += `\n${C.dim}Confidence:${C.reset} ${(result.confidence * 100).toFixed(1)}%  ${C.dim}Latency:${C.reset} ${(result.total_latency_us / 1000).toFixed(1)}ms  ${C.dim}Tokens:${C.reset} ${result.total_tokens}`;
      output += `  ${C.dim}${result.backend}${C.reset}`;

      if (result.daemon_info?.triggered_vaccination) {
        output += `\n${C.magenta}💉 Vaccination triggered!${C.reset}`;
      }

      const hits = result.script_results.filter((r: ScriptResult) => r.verdict === "malicious");
      if (hits.length > 0) {
        output += `\n\n${C.bold}Matched antibodies:${C.reset}\n`;
        for (const h of hits) {
          output += `  ${C.red}●${C.reset} ${h.antibody_id}: ${h.reason ?? "detected"} (${(h.confidence * 100).toFixed(0)}%)\n`;
        }
      }

      this.showSystemMessage(output);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.showSystemMessage(`${C.red}❌ Scan failed:${C.reset} ${translateLlmError(err)}`);
    }
  }

  // ── Antibody / Antigen ──────────────────────────────────────

  private async doAntibodyList(): Promise<void> {
    const antibodies = loadAntibodies();
    if (antibodies.length === 0) { this.showSystemMessage("No antibodies loaded."); return; }
    let out = `${C.bold}Antibodies (${antibodies.length}):${C.reset}\n`;
    for (const ab of antibodies) {
      out += `  ${ab.config.id} [${ab.config.category}] tier=${ab.config.tier} gen=${ab.config.generation}\n`;
    }
    this.showSystemMessage(out);
  }

  private async doAntibodyAdd(id: string): Promise<void> {
    this.showSystemMessage(
      `Antibody "${id}" creation via TUI coming soon. Create folders directly in antibodies/<id>/ with config.yaml + README.md + detect.ts`,
    );
  }

  private async doAntibodyRemove(id: string): Promise<void> {
    const antibodies = loadAntibodies();
    const ab = antibodies.find((a) => a.config.id === id);
    if (!ab) { this.showSystemMessage(`Antibody "${id}" not found.`); return; }
    this.showSystemMessage(
      `${C.yellow}Removing antibody "${id}" [${ab.config.category}]${C.reset}\n` +
      `${C.dim}Manual removal required: delete antibodies/${id}/${C.reset}`,
    );
  }

  private async doAntigenShow(id: string): Promise<void> {
    const antigens = loadAntigens();
    const ag = antigens.find((a) => a.config.id === id);
    if (!ag) { this.showSystemMessage(`Antigen "${id}" not found.`); return; }
    let out = `${C.bold}Antigen: ${ag.config.name}${C.reset} [${ag.config.id}]\n`;
    out += `Category: ${ag.config.category}\n`;
    out += `Injection: ${ag.config.injection_point}\n`;
    if (ag.payload) {
      out += `\nPayload:\n${ag.payload.slice(0, 500)}${ag.payload.length > 500 ? "..." : ""}`;
    }
    this.showSystemMessage(out);
  }

  private async doVaccinate(pattern: string): Promise<void> {
    const available = await isCaitlyndAvailable();
    if (!available) {
      this.showSystemMessage(`${C.yellow}⚠️ Vaccination requires caitlynd daemon.${C.reset}`);
      return;
    }
    try {
      const daemonUrl = process.env.CAITLYND_URL ?? "http://127.0.0.1:9070";
      const client = new CaitlyndClient(daemonUrl);
      const result = await client.vaccinate(pattern);
      this.showSystemMessage(`${C.green}✅ Vaccination complete:${C.reset} ${result.message}`);
    } catch (err) {
      this.showSystemMessage(`${C.red}❌ Vaccination failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Session Commands ────────────────────────────────────────

  private async doNewSession(): Promise<void> {
    const newMgr = SessionManager.create(process.cwd());
    this.showSystemMessage(`${C.green}New session:${C.reset} ${newMgr.getSessionId()}`);
    this.showSystemMessage(`${C.dim}Restart CAITLYN to begin the new session.${C.reset}`);
  }

  private async doResumeSession(): Promise<void> {
    const sessions = SessionManager.list(process.cwd());
    if (sessions.length === 0) {
      this.showSystemMessage("No saved sessions found.");
      return;
    }
    this.tui.showOverlay(buildSessionPickerOverlay(sessions), { anchor: "center", width: "70%", maxHeight: "70%" });
  }

  private async doSessionInfo(): Promise<void> {
    const mgr = this.sessionMgr;
    const stats = mgr.getTokenStats();
    const name = mgr.getSessionName();

    let out = `${C.bold}Session Info${C.reset}\n`;
    out += `ID:      ${mgr.getSessionId()}\n`;
    out += `File:    ${mgr.getSessionFile()}\n`;
    out += `Entries: ${mgr.getEntryCount()}\n`;
    if (name) out += `Name:    ${name}\n`;
    out += `Tokens:  ↑${stats.input} ↓${stats.output}\n`;
    if (stats.cost > 0) out += `Cost:    $${stats.cost.toFixed(4)}\n`;
    out += `CWD:     ${mgr.getCwd()}\n`;

    this.showSystemMessage(out);
  }

  private async doCompaction(): Promise<void> {
    const entries = this.sessionMgr.getAllEntries();
    const msgs = entries.filter((e) => e.type === "message") as MessageEntry[];
    if (msgs.length < 4) {
      this.showSystemMessage("Not enough messages to compact (need at least 4).");
      return;
    }

    // Simple: keep last 50% of messages, summarize the rest
    const cutIndex = Math.floor(msgs.length / 2);
    const oldMsgs = msgs.slice(0, cutIndex);
    const firstKeptId = msgs[cutIndex].id;

    const summaryText = oldMsgs
      .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
      .join("\n");

    // Use LLM to summarize if available
    let summary = "";
    try {
      const prompt = `Summarize this conversation history concisely (2-3 sentences), preserving key facts and decisions:\n\n${summaryText}`;
      summary = await this.llmCall("You are a summarizer. Be concise.", prompt);
    } catch {
      summary = `[Conversation history condensed — ${oldMsgs.length} earlier messages summarized]`;
    }

    const tokensBefore = oldMsgs.reduce(
      (sum, m) => sum + estimateTokens(m.content), 0,
    );

    this.sessionMgr.appendCompaction(summary, firstKeptId, tokensBefore);
    this.sessionMgr.flush();
    this.showSystemMessage(
      `${C.green}Compacted.${C.reset} Summarized ${oldMsgs.length} messages (≈${tokensBefore} tokens).`,
    );
  }

  private async maybeCompact(): Promise<void> {
    const entries = this.sessionMgr.getAllEntries();
    const msgs = entries.filter((e) => e.type === "message") as MessageEntry[];
    const totalTokens = msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const ctxWindow = getContextWindow(this.currentProvider, this.currentModelId);

    if (totalTokens > ctxWindow * 0.7 && msgs.length >= 4) {
      this.footer.update({ isAutoCompact: true });
      await this.doCompaction();
      this.footer.update({ isAutoCompact: false });
    }
  }

  private showSessionTree(): void {
    const tree = this.sessionMgr.getTree();
    function formatNode(node: typeof tree[0], depth: number): string {
      const e = node.entry;
      const indent = "  ".repeat(depth);
      let line = `${indent}${e.type}: ${e.id.slice(0, 8)}`;
      if (e.type === "message") {
        line += ` [${(e as MessageEntry).role}]`;
      } else if (e.type === "session_info") {
        line += ` "${(e as import("./session/session-types.js").SessionInfoEntry).name}"`;
      }
      return [line, ...node.children.flatMap((c) => formatNode(c, depth + 1))].join("\n");
    }

    const lines = tree.map((n) => formatNode(n, 0)).join("\n");
    this.showSystemMessage(
      `${C.bold}Session Tree:${C.reset}\n${lines || "(empty)"}`,
    );
  }

  private doFork(messageId: string): void {
    try {
      const newPath = this.sessionMgr.createBranchedSession(messageId);
      this.showSystemMessage(
        `${C.green}Forked session created:${C.reset} ${newPath}`,
      );
    } catch (err) {
      this.showSystemMessage(`${C.red}Fork failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private doClone(): void {
    const cloned = SessionManager.forkFrom(
      this.sessionMgr.getSessionFile(),
      process.cwd(),
    );
    this.showSystemMessage(`${C.green}Cloned session:${C.reset} ${cloned.getSessionFile()}`);
  }

  private doDelete(): void {
    const file = this.sessionMgr.getSessionFile();
    const items = [
      { value: "yes", label: `${C.red}Yes, delete session${C.reset}` },
      { value: "no", label: "No, keep session" },
    ];
    const list = new SelectList(items, 2, selectListTheme);
    const confirmText = new Text(`${C.yellow}Delete session?${C.reset}\n${C.dim}${file}${C.reset}`);
    const container = new Container();
    container.addChild(confirmText);
    container.addChild(list);
    const handle = this.tui.showOverlay(container, { anchor: "center", width: "60%", maxHeight: "30%" });
    list.onSelect = (item) => {
      handle.hide();
      if (item.value === "yes") {
        this.sessionMgr.delete();
        this.showSystemMessage(`${C.yellow}Session deleted:${C.reset} ${file}`);
      }
    };
    list.onCancel = () => {
      handle.hide();
    };
  }

  private async doModelSwitch(args: string): Promise<void> {
    const parts = args.split("/");
    if (parts.length < 2) {
      this.showSystemMessage("Usage: /model <provider/model>  (e.g., /model openrouter/deepseek/deepseek-chat)");
      return;
    }
    const provider = parts[0];
    const modelId = parts.slice(1).join("/");

    // Verify provider exists
    const foundProvider = getProviders().find((p) => p === provider);
    if (!foundProvider) {
      const available = getProviders().join(", ");
      this.showSystemMessage(
        `${C.red}Unknown provider "${provider}".${C.reset} Available: ${available}`,
      );
      return;
    }

    // Verify models are available for this provider
    const models = getModels(foundProvider);
    if (models.length === 0) {
      this.showSystemMessage(
        `${C.red}No models available for provider "${provider}".${C.reset} Check your API key configuration.`,
      );
      return;
    }

    // Verify the specific model exists
    const model = models.find((m) => m.id === modelId);
    if (!model) {
      const available = models.map((m) => m.id).join(", ");
      this.showSystemMessage(
        `${C.red}Model "${modelId}" not found for "${provider}".${C.reset} Available: ${available}`,
      );
      return;
    }

    this.currentProvider = provider;
    this.currentModelId = modelId;
    this.sessionMgr.appendModelChange(provider, modelId);
    this.sessionMgr.flush();
    this.footer.update({
      currentModel: getModelDisplay(provider, modelId),
      providerName: provider,
    });

    // Update agent model if available
    if (this.agent) {
      this.agent.state.model = model;
    }

    this.showSystemMessage(`${C.green}Model switched to:${C.reset} ${provider}/${modelId}`);
  }

  private async doLogin(provider: string): Promise<void> {
    if (!provider) {
      const configured = listConfiguredProviders();
      if (configured.length === 0) {
        this.showSystemMessage(
          "No providers configured. Set API keys via environment variables.\n" +
          "  export OPENROUTER_API_KEY=sk-...\n" +
          "  export OPENAI_API_KEY=sk-...\n" +
          "  etc.",
        );
      } else {
        this.showSystemMessage(`Configured providers: ${configured.join(", ")}`);
      }
      return;
    }
    this.showSystemMessage(
      `${C.dim}To configure ${provider}, set the appropriate environment variable or add the key to ~/.caitlyn/auth.json${C.reset}`,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────

  // ── Helpers ─────────────────────────────────────────────────

  private showSystemMessage(content: string): void {
    const md = new Markdown(content, 0, 0, THEME);
    this.insertBeforeEditor(md);
    this.tui.requestRender();
  }

  private showHelp(): void {
    const lines = [
      `${C.bold}${C.cyan}C A I T L Y N   C o m m a n d s${C.reset}`,
      ``,
      `${C.bold}Scanning & Defense:${C.reset}`,
      `  /scan <content>      Security scan for injection attacks`,
      `  /status              Show antibody/antigen library`,
      `  /dashboard           Defense statistics`,
      `  /history             Recent scan history`,
      `  /antibody list       List antibody forest`,
      `  /antigen <id>        Show antigen details`,
      `  /vaccinate <pattern> Evolve antibody`,
      ``,
      `${C.bold}Session:${C.reset}`,
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
      `${C.bold}Config:${C.reset}`,
      `  /model [provider/id] Switch LLM model`,
      `  /thinking <level>    off|low|medium|high`,
      `  /login [provider]    Configure auth`,
      `  /settings            Open settings`,
      ``,
      `${C.bold}Meta:${C.reset}`,
      `  /help                Show this help`,
      `  /clear               Clear screen`,
      `  /quit                Exit CAITLYN`,
      ``,
      `${C.dim}  !<content>           Quick scan alias${C.reset}`,
      ``,
      `${C.dim}  Ctrl+C quit  |  Esc back/abort  |  Tab back  |  q dismiss${C.reset}`,
    ];

    this.showSystemMessage(lines.join("\n"));
  }

  private refreshFooter(): void {
    const stats = this.sessionMgr.getTokenStats();
    this.footer.update({
      totalInput: stats.input,
      totalOutput: stats.output,
      totalCacheRead: stats.cacheRead,
      totalCacheWrite: stats.cacheWrite,
      totalCost: stats.cost,
      antibodyCount: loadAntibodies().length,
    });
    this.footer.invalidate();
  }

  // ── Run / Stop ──────────────────────────────────────────────

  async run(): Promise<void> {
    this.running = true;

    this.rejectionHandler = (reason: unknown) => {
      try {
        this.showSystemMessage(
          `${C.red}⚠️ Internal error:${C.reset} ${reason instanceof Error ? reason.message : String(reason)}\n${C.dim}CAITLYN continues running.${C.reset}`,
        );
      } catch { /* silently continue */ }
    };
    process.on("unhandledRejection", this.rejectionHandler);
    process.on("uncaughtException", (err) => this.rejectionHandler?.(err));

    this.sigintHandler = () => {
      this.stop();
    };
    process.on("SIGINT", this.sigintHandler);

    // Periodic footer refresh
    this.footerTimer = setInterval(() => {
      if (!this.running) return;
      this.refreshFooter();
      isCaitlyndAvailable().then((available) => {
        this.footer.update({
          daemonStatus: available ? "connected" : "disconnected",
        });
        this.footer.invalidate();
        this.tui.requestRender();
      }).catch(() => {});
    }, 30_000);

    // Welcome messages
    const antibodies = loadAntibodies();
    const daemonAvailable = await isCaitlyndAvailable();
    const daemonText = daemonAvailable ? `${C.green}connected${C.reset}` : `${C.yellow}not running${C.reset}`;
    const agentText = this.agent ? `${C.green}ready${C.reset}` : `${C.yellow}not loaded${C.reset}`;

    this.showSystemMessage(
      `${C.bold}${C.cyan}Welcome to CAITLYN!${C.reset}\n\n` +
      `Daemon: ${daemonText} | Agent: ${agentText} | Antibodies: ${antibodies.length}\n` +
      `${C.dim}Type to chat, /scan to inspect, /help for commands.  Ctrl+C to exit.${C.reset}`,
    );

    this.editor.disableSubmit = false;
    this.tui.setFocus(this.editor);
    this.tui.start();

    // Run until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });

    // Cleanup
    if (this.footerTimer) {
      clearInterval(this.footerTimer);
      this.footerTimer = null;
    }
    if (this.sigintHandler) {
      process.off("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.rejectionHandler) {
      process.off("unhandledRejection", this.rejectionHandler);
      process.off("uncaughtException", this.rejectionHandler);
      this.rejectionHandler = null;
    }
  }


  private abortResponse(): void {
    this.agent?.abort?.();
    if (this.currentLoader) {
      this.tui.removeChild(this.currentLoader);
      this.currentLoader = null;
    }
    this.showSystemMessage(`${C.yellow}Aborted.${C.reset}`);
    this.isResponding = false;
    this.editor.disableSubmit = false;
    this.tui.setFocus(this.editor);
  }
  stop(): void {
    this.running = false;
    this.sessionMgr.flush();
    this.tui.stop();

    if (this.footerTimer) {
      clearInterval(this.footerTimer);
      this.footerTimer = null;
    }
    if (this.sigintHandler) {
      process.off("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.rejectionHandler) {
      process.off("unhandledRejection", this.rejectionHandler);
      process.off("uncaughtException", this.rejectionHandler);
      this.rejectionHandler = null;
    }
  }
}
