/**
 * CAITLYN Agent — Terminal UI
 *
 * Full-screen interactive TUI built on @earendil-works/pi-tui.
 * Provides:
 *   - Chat message display with markdown rendering and relative timestamps
 *   - Command input with scan/status/dashboard/history/help
 *   - Antibody/antigen management (/antibody, /antigen)
 *   - Vaccination from TUI (/vaccinate) with SHM progress animation
 *   - Status bar with daemon connection + scan stats, auto-refresh
 *   - Keyboard shortcuts footer bar
 *   - Spinner animation during scan with phase icons
 *   - Color-coded verdicts (MALICIOUS red, SUSPICIOUS yellow, BENIGN green)
 *   - Caitlyn-themed Unicode logo (rifle, crosshair, hat)
 *
 * Usage:
 *   const tui = await CaitlynTUI.create(llmCall);
 *   await tui.run();
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  TUI,
  Container,
  Input,
  Markdown,
  Text,
  ProcessTerminal,
  Key,
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
import type { ScriptResult, AntigenEntry } from "./schema.js";
import { CaitlyndClient } from "./caitlynd-client.js";

// ── ANSI Helpers ──────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  magenta: "\x1b[35m",
  white:   "\x1b[37m",
} as const;

// ── Logo ──────────────────────────────────────────────────────────

const noEmoji = process.env.CAITLYN_NO_EMOJI === "1";

const CAITLYN_LOGO = [
  "  ╔═══════════════════════════════════════════════╗",
  "  ║   ▄▄▄══━★  CAITLYN  ━━╤╤╤╤━━  ║",
  "  ║   ╔═══╗     Sheriff of Piltover     ║",
  "  ║   ║ o ║    ⊕ Precision Defense ⊕    ║",
  "  ║   ╚═══╝                             ║",
  "  ║   ━━━━◉━━━━━  Targeting...  ━━━━━◉━━━━━ ║",
  "  ╚═══════════════════════════════════════════════╝",
].join("\n");

const CAITLYN_LOGO_ASCII = [
  "  +===============================================+",
  "  |   ___===---*  CAITLYN  ----++++----  |",
  "  |   +-----+     Sheriff of Piltover     |",
  "  |   |  o  |    (o) Precision Defense (o)  |",
  "  |   +-----+                             |",
  "  |   ------*-------  Targeting...  -------*----- |",
  "  +===============================================+",
].join("\n");

// ── LLM Error Translation ─────────────────────────────────────────

function translateLlmError(err: Error): string {
  const msg = err.message;
  if (msg.includes("401") || msg.includes("Unauthorized")) {
    return "API key not valid. Set CAITLYN_PROVIDER and <PROVIDER>_API_KEY.";
  }
  if (msg.includes("402") || msg.includes("Payment Required") || msg.includes("quota")) {
    return "LLM API quota exceeded. Check your billing or switch provider.";
  }
  if (msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("rate limit")) {
    return "LLM API rate limit reached. Wait a moment and try again.";
  }
  if (msg.includes("Connection refused") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return "Cannot reach LLM API. Check your network connection.";
  }
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
    return "LLM API timed out. The service may be overloaded.";
  }
  if (msg.includes("503") || msg.includes("Service Unavailable")) {
    return "LLM API service temporarily unavailable. Try again later.";
  }
  return msg;
}

// ── Theme ─────────────────────────────────────────────────────────

const THEME: MarkdownTheme = {
  heading: (t: string) => `${C.bold}${C.cyan}${t}${C.reset}`,
  link: (t: string) => `${C.cyan}${t}${C.reset}`,
  linkUrl: (t: string) => `${C.dim}${t}${C.reset}`,
  code: (t: string) => `${C.yellow}${t}${C.reset}`,
  codeBlock: (t: string) => `${C.dim}${t}${C.reset}`,
  codeBlockBorder: (t: string) => `${C.dim}${t}${C.reset}`,
  quote: (t: string) => `${C.dim}${t}${C.reset}`,
  quoteBorder: (t: string) => `${C.dim}│${C.reset}`,
  hr: (t: string) => `${C.dim}${t}${C.reset}`,
  listBullet: (t: string) => `${C.cyan}${t}${C.reset}`,
  bold: (t: string) => `${C.bold}${t}${C.reset}`,
  italic: (t: string) => t,
  strikethrough: (t: string) => `${C.dim}${t}${C.reset}`,
  underline: (t: string) => t,
};

// ── Message Types ─────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// ── Chat View Component ───────────────────────────────────────────

class ChatView implements Component {
  private messages: ChatMessage[] = [];
  private markdowns: Markdown[] = [];
  private dirty = true;

  addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    if (this.messages.length > 100) {
      this.messages = this.messages.slice(-100);
    }
    this.dirty = true;
  }

  addSystemMessage(content: string): void {
    this.addMessage({ role: "system", content, timestamp: Date.now() });
  }

  updateLastSystemMessage(content: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "system") {
      last.content = content;
      last.timestamp = Date.now();
    } else {
      this.addSystemMessage(content);
    }
    this.dirty = true;
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    if (this.dirty) {
      this.markdowns = this.messages.map((msg) => {
        const timeStr = formatRelativeTime(msg.timestamp);
        const prefix = msg.role === "user"
          ? `${C.bold}${C.green}You${C.reset}  ${C.dim}${timeStr}${C.reset}  `
          : msg.role === "system"
            ? `${C.bold}${C.yellow}⚡${C.reset} ${C.dim}${timeStr}${C.reset} `
            : `${C.bold}${C.cyan}CAITLYN${C.reset} ${C.dim}${timeStr}${C.reset} `;
        return new Markdown(prefix + msg.content, 0, 0, THEME);
      });
      this.dirty = false;
    }

    const lines: string[] = [];
    for (const md of this.markdowns) {
      lines.push(...md.render(width));
      lines.push("");
    }
    return lines;
  }
}

function formatRelativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Status Bar Component ──────────────────────────────────────────

class StatusBar implements Component {
  private daemonStatus = "checking...";
  private lastScanInfo = "";
  private dirty = true;

  setDaemonStatus(status: string): void {
    this.daemonStatus = status;
    this.dirty = true;
  }

  setLastScan(info: string): void {
    this.lastScanInfo = info;
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    this.dirty = false;
    const left = `${C.cyan}🛡️ caitlynd${C.reset}: ${this.daemonStatus}`;
    const right = this.lastScanInfo;
    const spacer = Math.max(1, width - left.length - right.length - 3);
    return [`${C.dim}${"─".repeat(width)}${C.reset}`, `${left} ${" ".repeat(spacer)} ${right}`];
  }
}

// ── Footer Bar Component ─────────────────────────────────────────

class FooterBar implements Component {
  private dirty = true;

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    this.dirty = false;
    const shortcuts = [
      `${C.dim}^C${C.reset} quit`,
      `${C.dim}/scan${C.reset}`,
      `${C.dim}/status${C.reset}`,
      `${C.dim}/dashboard${C.reset}`,
      `${C.dim}/help${C.reset}`,
    ];
    const joined = shortcuts.join("  ");
    const pad = Math.max(0, width - joined.length);
    return [
      `${C.dim}${"─".repeat(width)}${C.reset}`,
      `${joined}${" ".repeat(pad)}`,
    ];
  }
}

// ── Main TUI App ──────────────────────────────────────────────────

export class CaitlynTUI {
  private tui: TUI;
  private chatView: ChatView;
  private input: Input;
  private statusBar: StatusBar;
  private footerBar: FooterBar;
  private agent: Agent | null = null;
  private llmCall: LlmCallFn;
  private running = false;
  private daemonAutoStarted = false;
  private daemonPid: number | null = null;
  private statusBarInterval: ReturnType<typeof setInterval> | null = null;
  private commandHistory: string[] = [];
  private historyIndex = -1;
  private highContrast = process.env.CAITLYN_HIGH_CONTRAST === "1";

  private constructor(
    tui: TUI,
    chatView: ChatView,
    input: Input,
    statusBar: StatusBar,
    footerBar: FooterBar,
    agent: Agent | null,
    llmCall: LlmCallFn,
  ) {
    this.tui = tui;
    this.chatView = chatView;
    this.input = input;
    this.statusBar = statusBar;
    this.footerBar = footerBar;
    this.agent = agent;
    this.llmCall = llmCall;
  }

  static async create(
    llmCall: LlmCallFn,
    agent?: Agent | null,
  ): Promise<CaitlynTUI> {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    tui.setClearOnShrink(false);

    // Minimum terminal size check
    const { columns = 80, rows = 24 } = process.stdout;
    if (columns < 80 || rows < 24) {
      console.warn(
        `⚠️  Terminal is ${columns}×${rows}. CAITLYN works best at 80×24 or larger.`,
      );
    }

    const header = new Text("");
    const logo = noEmoji ? CAITLYN_LOGO_ASCII : CAITLYN_LOGO;
    header.setText(`${C.bold}${C.cyan}${logo}${C.reset}\n`);
    tui.addChild(header);

    const chatView = new ChatView();
    tui.addChild(chatView);

    const statusBar = new StatusBar();
    const footerBar = new FooterBar();
    const input = new Input();

    tui.addChild(input);
    tui.addChild(statusBar);
    tui.addChild(footerBar);

    const daemonAvailable = await isCaitlyndAvailable();
    if (daemonAvailable) {
      const st = await getCaitlyndStatus();
      if (st) {
        const uptimeStr = st.uptime_seconds != null
          ? `, ${(st.uptime_seconds / 3600).toFixed(1)}h uptime`
          : "";
        statusBar.setDaemonStatus(
          `${C.green}connected${C.reset} (${st.active_antibodies} antibodies, ${st.memory_entries} memory${uptimeStr})`,
        );
      } else {
        statusBar.setDaemonStatus(`${C.green}connected${C.reset}`);
      }
    } else {
      statusBar.setDaemonStatus(`${C.yellow}local mode${C.reset} (daemon not running)`);
    }

    const self = new CaitlynTUI(tui, chatView, input, statusBar, footerBar, agent ?? null, llmCall);

    input.onSubmit = async (value: string) => {
      await self.handleCommand(value);
    };

    return self;
  }

  async handleCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed.length > 100_000) {
      this.chatView.addSystemMessage(`${C.yellow}Content too long (max 100,000 characters).${C.reset}`);
      this.input.setValue("");
      this.tui.requestRender();
      return;
    }

    // Record in command history (deduplicate consecutive)
    if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== trimmed) {
      this.commandHistory.push(trimmed);
      if (this.commandHistory.length > 100) this.commandHistory.shift();
    }
    this.historyIndex = this.commandHistory.length;

    this.chatView.addMessage({ role: "user", content: trimmed, timestamp: Date.now() });

    if (trimmed.startsWith("/")) {
      await this.handleSlashCommand(trimmed);
    } else if (trimmed.startsWith("!")) {
      await this.handleBangCommand(trimmed);
    } else {
      await this.handleChat(trimmed);
    }

    this.input.setValue("");
    this.tui.requestRender();
  }

  private async handleSlashCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const verb = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (verb) {
      case "/scan": {
        if (!args) { this.chatView.addSystemMessage("Usage: /scan <content>"); return; }
        await this.doScan(args);
        break;
      }
      case "/status": {
        await this.doStatus();
        break;
      }
      case "/dashboard": {
        await this.doDashboard();
        break;
      }
      case "/history": {
        await this.doHistory(parseInt(parts[1]) || 10);
        break;
      }
      case "/antibody": {
        const subCmd = parts[1]?.toLowerCase();
        const abId = parts[2];
        if (subCmd === "list") { await this.doAntibodyList(); }
        else if (subCmd === "add" && abId) { await this.doAntibodyAdd(abId); }
        else if (subCmd === "remove" && abId) { await this.doAntibodyRemove(abId); }
        else { this.chatView.addSystemMessage("Usage: /antibody list | add <id> | remove <id>"); }
        break;
      }
      case "/antigen": {
        if (!args) { this.chatView.addSystemMessage("Usage: /antigen <id>"); return; }
        await this.doAntigenShow(args.trim());
        break;
      }
      case "/vaccinate": {
        if (!args) { this.chatView.addSystemMessage("Usage: /vaccinate <pattern>"); return; }
        await this.doVaccinate(args);
        break;
      }
      case "/help": {
        this.chatView.addSystemMessage(
          "Commands:\n" +
          "  /scan <content>      — Security scan for injection attacks\n" +
          "  /status              — Show antibody/antigen library\n" +
          "  /dashboard           — Defense statistics dashboard\n" +
          "  /history [N]         — Recent scan history\n" +
          "  /antibody list       — List all antibodies\n" +
          "  /antibody add <id>   — Create a new antibody (coming soon)\n" +
          "  /antibody remove <id> — Remove an antibody\n" +
          "  /antigen <id>        — Show antigen config and payload\n" +
          "  /vaccinate <pattern> — Submit vaccination pattern to daemon\n" +
          "  /help                — Show this help\n" +
          "  /quit                — Exit CAITLYN\n\n" +
          "  !<content>           — Quick security scan (same as /scan)\n" +
          "  Anything else        — Chat with CAITLYN guardian agent",
        );
        break;
      }
      case "/quit": case "/exit": {
        this.chatView.addSystemMessage("Goodbye. Stay secure.");
        this.stop();
        break;
      }
      default: {
        this.chatView.addSystemMessage(`Unknown command: ${verb}. Type /help for commands.`);
      }
    }
  }

  private async handleBangCommand(cmd: string): Promise<void> {
    // ! prefix = quick scan (alternative to /scan)
    const content = cmd.slice(1).trim();
    if (!content) { this.chatView.addSystemMessage("Usage: !<content> — quick security scan"); return; }
    await this.doScan(content);
  }

  private async handleChat(message: string): Promise<void> {
    // Route plain text to agent conversation
    if (!this.agent) {
      this.chatView.addSystemMessage(
        `${C.yellow}Agent not available.${C.reset} Use ${C.cyan}/scan <content>${C.reset} for security scanning, or start with LLM configured.`,
      );
      return;
    }
    try {
      await this.agent.prompt(message);
      // After prompt, capture the agent's latest response
      this.displayAgentResponse();
    } catch (e) {
      this.chatView.addSystemMessage(
        `${C.red}Agent error:${C.reset} ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Extract and display the latest assistant messages from the agent's transcript. */
  private displayAgentResponse(): void {
    if (!this.agent) return;
    const messages = this.agent.state.messages;
    // Find new assistant messages since last display
    let found = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const text = msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (text) {
          this.chatView.addMessage({ role: "assistant", content: text, timestamp: Date.now() });
          found = true;
          break; // Just show the latest
        }
      }
    }
    if (!found) {
      this.chatView.addSystemMessage(`${C.dim}(no response)${C.reset}`);
    }
  }

  private async doScan(content: string): Promise<void> {
    this.chatView.addSystemMessage(`⊕ Scanning (${content.length} chars)...`);

    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIdx = 0;
    let phase = 0;
    const phases = ["scanning", "analyzing", "classifying"];
    const phaseIcons = ["⊕", "◉", "◎"];

    const spinnerInterval = setInterval(() => {
      if (!this.running) { clearInterval(spinnerInterval); return; }
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
      phase = Math.floor(spinnerIdx / 6) % phases.length;
      this.chatView.updateLastSystemMessage(
        `${spinnerFrames[spinnerIdx]} ${phaseIcons[phase]} ${phases[phase]}... (${content.length} chars)`,
      );
      this.tui.requestRender();
    }, 100);

    try {
      const result = await hybridScan({ content, llmCall: this.llmCall });
      clearInterval(spinnerInterval);

      // Screen-reader-friendly: text before emoji
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

      this.chatView.updateLastSystemMessage(output);
      this.statusBar.setLastScan(`${emoji} ${verdict} ${(result.total_latency_us / 1000).toFixed(1)}ms`);
    } catch (e) {
      clearInterval(spinnerInterval);
      const err = e instanceof Error ? e : new Error(String(e));
      const friendly = translateLlmError(err);
      this.chatView.updateLastSystemMessage(
        `${C.red}❌ Scan failed:${C.reset} ${friendly}`,
      );
      this.statusBar.setLastScan("❌ failed");
    }
  }

  private async doStatus(): Promise<void> {
    const antibodies = loadAntibodies();
    const antigens = loadAntigens();
    const index = loadAntibodyIndex() ?? buildAntibodyIndex(antibodies);

    let output = `🛡️  **CAITLYN Library**\n`;
    output += `${antibodies.length} antibodies (${index.roots.length} roots), ${antigens.length} antigens\n\n`;

    output += "**Antibodies:**\n";
    for (const rid of index.roots) {
      const ab = antibodies.find((a) => a.config.id === rid);
      if (ab) {
        const tp = ab.config.stats?.true_positives ?? 0;
        const fp = ab.config.stats?.false_positives ?? 0;
        output += `  📁 ${ab.config.id} [${ab.config.category}] tier=${ab.config.tier} | TP=${tp} FP=${fp}\n`;
      }
    }

    const byCat: Record<string, number> = {};
    for (const ag of antigens) byCat[ag.config.category] = (byCat[ag.config.category] || 0) + 1;
    output += "\n**Antigens:**\n";
    for (const [cat, count] of Object.entries(byCat)) {
      output += `  - ${cat}: ${count}\n`;
    }

    this.chatView.addSystemMessage(output);
  }

  private async doDashboard(): Promise<void> {
    const stats = getDashboard();
    if (stats.total_scans === 0) {
      this.chatView.addSystemMessage("📊 No scan data yet.");
      return;
    }

    let output = "📊 **CAITLYN Dashboard**\n\n";
    output += `Total Scans:      ${stats.total_scans}\n`;
    output += `Detected (🚨):    ${stats.malicious_count}\n`;
    output += `Clean (✅):       ${stats.benign_count}\n`;
    output += `Detection Rate:   ${(stats.detection_rate * 100).toFixed(1)}%\n\n`;
    output += `Avg Latency:      ${stats.avg_latency_ms.toFixed(2)}ms\n`;
    output += `Avg Tokens:       ${stats.avg_tokens.toFixed(1)}\n`;
    output += `Total Tokens:     ${stats.total_tokens}\n\n`;
    output += `Tier 0 Hits:      ${stats.tier0_hits} | Tier 1: ${stats.tier1_hits}\n`;
    output += `Last Scan:        ${stats.last_scan_at ?? "N/A"}\n`;

    if (stats.top_antibodies.length > 0) {
      output += "\n**Top Antibodies:**\n";
      for (const a of stats.top_antibodies.slice(0, 5)) {
        output += `  - ${a.id}: ${a.hits} hits\n`;
      }
    }

    this.chatView.addSystemMessage(output);
  }

  private async doHistory(limit: number): Promise<void> {
    const { getHistory } = await import("./history.js");
    const entries = getHistory(limit);
    if (entries.length === 0) {
      this.chatView.addSystemMessage("No scan history yet.");
      return;
    }

    let output = `📋 **Recent Scans** (${entries.length})\n\n`;
    for (const e of entries) {
      const emoji = e.verdict === "malicious" ? "🚨" : e.verdict === "suspicious" ? "⚠️" : "✅";
      output += `${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} | T${e.tier} | ${e.content_preview}\n`;
    }
    this.chatView.addSystemMessage(output);
  }

  // ── Antibody CRUD ─────────────────────────────────────────────

  private async doAntibodyList(): Promise<void> {
    const antibodies = loadAntibodies();
    if (antibodies.length === 0) {
      this.chatView.addSystemMessage("No antibodies loaded.");
      return;
    }
    let output = "**Antibodies:**\n";
    for (const ab of antibodies) {
      output += `  📁 ${ab.config.id} [${ab.config.category}] tier=${ab.config.tier} gen=${ab.config.generation}\n`;
    }
    this.chatView.addSystemMessage(output);
  }

  private async doAntibodyAdd(id: string): Promise<void> {
    this.chatView.addSystemMessage(
      `Antibody "${id}" creation via TUI coming soon. Create antibody folders directly in antibodies/<id>/ with config.yaml + README.md + detect.ts`,
    );
  }

  private async doAntibodyRemove(id: string): Promise<void> {
    const antibodies = loadAntibodies();
    const ab = antibodies.find((a) => a.config.id === id);
    if (!ab) {
      this.chatView.addSystemMessage(`Antibody "${id}" not found.`);
      return;
    }
    // Show what would be removed
    this.chatView.addSystemMessage(
      `Removing antibody "${id}" [${ab.config.category}] from ${ab.folderPath}\n` +
      `This action cannot be undone. Type /confirm-remove ${id} to proceed.`,
    );
    // Note: actual deletion deferred to /confirm-remove for safety
  }

  // ── Antigen View ──────────────────────────────────────────────

  private async doAntigenShow(id: string): Promise<void> {
    const antigens = loadAntigens();
    const ag = antigens.find((a) => a.config.id === id);
    if (!ag) {
      this.chatView.addSystemMessage(`Antigen "${id}" not found.`);
      return;
    }
    let output = `**Antigen: ${ag.config.name}** [${ag.config.id}]\n`;
    output += `Category: ${ag.config.category}\n`;
    output += `Injection point: ${ag.config.injection_point}\n`;
    output += `Target agent: ${ag.config.target_agent}\n`;
    output += `Template: ${ag.config.attack_template}\n`;
    if (ag.config.escapes.length > 0) {
      output += `Known escapes: ${ag.config.escapes.join(", ")}\n`;
    }
    if (ag.payload) {
      const payloadPreview = ag.payload.length > 500
        ? ag.payload.slice(0, 497) + "..."
        : ag.payload;
      output += `\n**Payload:**\n\`\`\`\n${payloadPreview}\n\`\`\``;
    }
    this.chatView.addSystemMessage(output);
  }

  // ── Vaccination ───────────────────────────────────────────────

  private async doVaccinate(pattern: string): Promise<void> {
    const available = await isCaitlyndAvailable();
    if (!available) {
      this.chatView.addSystemMessage(
        `${C.yellow}⚠️  Vaccination requires caitlynd daemon.${C.reset}\n` +
        `Start with: cargo run -- --port 9070`,
      );
      return;
    }

    const stages = ["⚡ SHM mutating...", "🧬 Affinity testing...", "💉 Antibody born!"];
    let stageIdx = 0;
    this.chatView.addSystemMessage(stages[stageIdx]);

    const stageInterval = setInterval(() => {
      if (!this.running) { clearInterval(stageInterval); return; }
      stageIdx = Math.min(stageIdx + 1, stages.length - 1);
      this.chatView.updateLastSystemMessage(stages[stageIdx]);
      this.tui.requestRender();
    }, 800);

    try {
      const daemonUrl = process.env.CAITLYND_URL ?? "http://127.0.0.1:9070";
      const client = new CaitlyndClient(daemonUrl);
      const result = await client.vaccinate(pattern);
      clearInterval(stageInterval);
      this.chatView.updateLastSystemMessage(
        `${C.green}✅ Vaccination complete:${C.reset} ${result.message}`,
      );
    } catch (err) {
      clearInterval(stageInterval);
      this.chatView.updateLastSystemMessage(
        `${C.red}❌ Vaccination failed:${C.reset} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Run / Stop ──────────────────────────────────────────────────

  async run(): Promise<void> {
    this.running = true;

    const rejectionHandler = (reason: unknown) => {
      try {
        this.chatView.addSystemMessage(
          `${C.red}⚠️ Internal error:${C.reset} ${reason instanceof Error ? reason.message : String(reason)}\n${C.dim}CAITLYN continues running. Report this bug if it persists.${C.reset}`,
        );
        this.tui.requestRender();
      } catch {
        // Can't even show the error — silently continue
      }
    };
    process.on("unhandledRejection", rejectionHandler);
    process.on("uncaughtException", (err) => {
      rejectionHandler(err);
    });

    const sigintHandler = () => {
      this.chatView.addSystemMessage(`${C.cyan}Goodbye.${C.reset}`);
      this.stop();
    };
    process.on("SIGINT", sigintHandler);

    // Status bar auto-refresh every 30s
    this.statusBarInterval = setInterval(async () => {
      try {
        const available = await isCaitlyndAvailable();
        if (available) {
          const st = await getCaitlyndStatus();
          if (st) {
            const uptimeStr = st.uptime_seconds != null
              ? `, ${(st.uptime_seconds / 3600).toFixed(1)}h uptime`
              : "";
            this.statusBar.setDaemonStatus(
              `${C.green}connected${C.reset} (${st.active_antibodies} antibodies, ${st.memory_entries} memory${uptimeStr})`,
            );
          } else {
            this.statusBar.setDaemonStatus(`${C.green}connected${C.reset}`);
          }
        } else {
          this.statusBar.setDaemonStatus(`${C.yellow}local mode${C.reset} (daemon not running)`);
        }
        this.statusBar.invalidate();
        this.tui.requestRender();
      } catch {
        // Status refresh failed silently
      }
    }, 30_000);

    // Welcome message
    const antibodies = loadAntibodies();
    const daemonAvailable = await isCaitlyndAvailable();
    const daemonText = daemonAvailable ? `${C.green}connected${C.reset}` : `${C.yellow}not running${C.reset}`;
    const agentText = this.agent ? `${C.green}ready${C.reset}` : `${C.yellow}not loaded${C.reset}`;

    // Onboarding: first-run check
    const historyEntries = loadHistory();
    if (historyEntries.length === 0) {
      this.chatView.addSystemMessage(
        `${C.bold}${C.cyan}Welcome to CAITLYN!${C.reset}\n\n` +
        `Here's how to get started:\n` +
        `1) ${C.cyan}Type anything${C.reset} — chat with the CAITLYN security agent\n` +
        `2) ${C.cyan}/scan <content>${C.reset} — scan content for injection attacks\n` +
        `3) ${C.cyan}/dashboard${C.reset} — view defense statistics\n` +
        `4) ${C.cyan}/help${C.reset} — see all commands`,
      );
    }

    this.chatView.addSystemMessage(
      `${C.dim}Continuous Agents for Injection Threats via Lifelong Yielding Nexus${C.reset}\n` +
      `${C.dim}AI Agent Immune System${C.reset}\n\n` +
      `Daemon: ${daemonText} | Agent: ${agentText} | Antibodies: ${antibodies.length}\n` +
      `${C.dim}Type to chat, /scan to inspect, /help for commands.  Ctrl+C to exit.${C.reset}`,
    );

    this.tui.setFocus(this.input);
    this.tui.start();

    // Run until stopped
    await new Promise<void>((resolve) => {
      const checkStop = setInterval(() => {
        if (!this.running) {
          clearInterval(checkStop);
          resolve();
        }
      }, 100);
    });

    // Cleanup
    if (this.statusBarInterval) {
      clearInterval(this.statusBarInterval);
      this.statusBarInterval = null;
    }
    process.off("SIGINT", sigintHandler);
    process.off("unhandledRejection", rejectionHandler);
    process.off("uncaughtException", rejectionHandler);
  }

  stop(): void {
    this.running = false;
    this.tui.stop();

    if (this.statusBarInterval) {
      clearInterval(this.statusBarInterval);
      this.statusBarInterval = null;
    }

    // Kill auto-started daemon
    if (this.daemonAutoStarted && this.daemonPid) {
      try {
        process.kill(this.daemonPid, "SIGTERM");
        console.log("Stopped auto-started caitlynd daemon.");
      } catch {
        // Already dead
      }
    }
  }
}
