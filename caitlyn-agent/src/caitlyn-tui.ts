/**
 * CAITLYN Agent — Terminal UI
 *
 * Full-screen interactive TUI built on @earendil-works/pi-tui.
 * Provides:
 *   - Chat message display (markdown rendering)
 *   - Command input with scan/status/dashboard/history/help
 *   - Status bar with daemon connection status + scan stats
 *   - Inline scan result display
 *
 * Usage:
 *   const tui = await CaitlynTUI.create(llmCall);
 *   await tui.run();
 */

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
import { getDashboard } from "./history.js";
import { loadAntibodies, loadAntigens, loadAntibodyIndex, buildAntibodyIndex } from "./library.js";
import type { ScriptResult } from "./schema.js";

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
    // Keep last 100 messages max
    if (this.messages.length > 100) {
      this.messages = this.messages.slice(-100);
    }
    this.dirty = true;
  }

  addSystemMessage(content: string): void {
    this.addMessage({ role: "system", content, timestamp: Date.now() });
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    if (this.dirty) {
      this.markdowns = this.messages.map((msg) => {
        const prefix = msg.role === "user"
          ? `${C.bold}${C.green}You${C.reset}  `
          : msg.role === "system"
            ? `${C.bold}${C.yellow}⚡${C.reset} `
            : `${C.bold}${C.cyan}CAITLYN${C.reset} `;
        return new Markdown(prefix + msg.content, 0, 0, THEME);
      });
      this.dirty = false;
    }

    const lines: string[] = [];
    for (const md of this.markdowns) {
      lines.push(...md.render(width));
      lines.push(""); // spacer between messages
    }
    return lines;
  }
}

// ── Status Bar Component ──────────────────────────────────────────

class StatusBar implements Component {
  private daemonStatus = "checking...";
  private lastScanInfo = "";
  private width = 80;
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
    this.width = width;
    this.dirty = false;
    const left = `${C.cyan}🛡️ caitlynd${C.reset}: ${this.daemonStatus}`;
    const right = this.lastScanInfo;
    const spacer = Math.max(1, width - left.length - right.length - 3);
    return [`${C.dim}${"─".repeat(width)}${C.reset}`, `${left} ${" ".repeat(spacer)} ${right}`];
  }
}

// ── Main TUI App ──────────────────────────────────────────────────

export class CaitlynTUI {
  private tui: TUI;
  private chatView: ChatView;
  private input: Input;
  private statusBar: StatusBar;
  private agent: Agent | null = null;
  private llmCall: LlmCallFn;
  private running = false;

  private constructor(
    tui: TUI,
    chatView: ChatView,
    input: Input,
    statusBar: StatusBar,
    agent: Agent | null,
    llmCall: LlmCallFn,
  ) {
    this.tui = tui;
    this.chatView = chatView;
    this.input = input;
    this.statusBar = statusBar;
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

    // ── Header ──
    const header = new Text("");
    const updateHeader = () => {
      const daemonAvailable = false; // will update below
      header.setText(
        `${C.bold}${C.cyan}🛡️  CAITLYN${C.reset}  ${C.dim}Security Guardian${C.reset}\n`,
      );
    };
    updateHeader();
    tui.addChild(header);

    // ── Chat view ──
    const chatView = new ChatView();
    tui.addChild(chatView);

    // ── Input ──
    const statusBar = new StatusBar();
    const input = new Input();
    input.onSubmit = () => {}; // placeholder, set below
    tui.addChild(input);
    tui.addChild(statusBar);

    // Update daemon status
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

    const self = new CaitlynTUI(tui, chatView, input, statusBar, agent ?? null, llmCall);

    // Wire input submit
    input.onSubmit = async (value: string) => {
      await self.handleCommand(value);
    };

    return self;
  }

  async handleCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    this.chatView.addMessage({ role: "user", content: trimmed, timestamp: Date.now() });

    if (trimmed.startsWith("/")) {
      await this.handleSlashCommand(trimmed);
    } else if (trimmed.startsWith("!")) {
      await this.handleBangCommand(trimmed);
    } else {
      // Route to agent chat
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
      case "/help": {
        this.chatView.addSystemMessage(
          "Commands:\n" +
          "  /scan <content>   — Scan content for attacks\n" +
          "  /status           — Show antibody/antigen library\n" +
          "  /dashboard        — Defense statistics dashboard\n" +
          "  /history [N]      — Recent scan history\n" +
          "  /help             — Show this help\n" +
          "  /quit             — Exit CAITLYN\n\n" +
          "  !<message>        — Chat with CAITLYN guardian agent\n" +
          "  Just type anything — Auto-scanned for threats",
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
    const message = cmd.slice(1).trim();
    if (!this.agent) {
      this.chatView.addSystemMessage("Agent not initialized. Start without --no-agent flag.");
      return;
    }
    try {
      await this.agent.prompt(message);
    } catch (e) {
      this.chatView.addSystemMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleChat(message: string): Promise<void> {
    // Auto-scan free-form input
    await this.doScan(message);
  }

  private async doScan(content: string): Promise<void> {
    this.chatView.addSystemMessage(`🔍 Scanning (${content.length} chars)...`);

    try {
      const result = await hybridScan({ content, llmCall: this.llmCall });
      const emoji = result.verdict === "malicious" ? "🚨" : "✅";
      const color = result.verdict === "malicious" ? C.red : C.green;

      let output = `${color}${emoji} ${result.verdict.toUpperCase()}${C.reset} (${(result.confidence * 100).toFixed(1)}%)`;
      output += ` | ${C.dim}${(result.total_latency_us / 1000).toFixed(1)}ms${C.reset}`;
      output += ` | ${C.dim}${result.total_tokens} tokens${C.reset}`;
      output += ` | ${C.dim}${result.backend}${C.reset}`;

      if (result.daemon_info?.triggered_vaccination) {
        output += `\n${C.magenta}💉 Vaccination triggered!${C.reset}`;
      }

      // Show matched antibodies
      const hits = result.script_results.filter((r: ScriptResult) => r.verdict === "malicious");
      if (hits.length > 0) {
        output += `\n\n${C.bold}Matched antibodies:${C.reset}\n`;
        for (const h of hits) {
          output += `  ${C.red}●${C.reset} ${h.antibody_id}: ${h.reason ?? "detected"} (${(h.confidence * 100).toFixed(0)}%)\n`;
        }
      }

      this.chatView.addSystemMessage(output);
      this.statusBar.setLastScan(`${emoji} ${result.verdict.toUpperCase()} ${(result.total_latency_us / 1000).toFixed(1)}ms`);
    } catch (e) {
      this.chatView.addSystemMessage(`${C.red}❌ Scan failed:${C.reset} ${e instanceof Error ? e.message : String(e)}`);
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
      const emoji = e.verdict === "malicious" ? "🚨" : "✅";
      output += `${emoji} ${e.timestamp.slice(0, 19)} | ${e.verdict.toUpperCase()} | T${e.tier} | ${e.content_preview}\n`;
    }
    this.chatView.addSystemMessage(output);
  }

  async run(): Promise<void> {
    this.running = true;

    // Welcome message
    const antibodies = loadAntibodies();
    const daemonAvailable = await isCaitlyndAvailable();
    const daemonText = daemonAvailable ? `${C.green}connected${C.reset}` : `${C.yellow}not running${C.reset}`;

    this.chatView.addSystemMessage(
      `${C.bold}${C.cyan}CAITLYN Security Guardian${C.reset}\n` +
      `${C.dim}Continuous Agents for Injection Threats via Lifelong Yielding Nexus${C.reset}\n\n` +
      `Daemon: ${daemonText} | Antibodies: ${antibodies.length}\n` +
      `Type /help for commands or just paste content to scan.`,
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
  }

  stop(): void {
    this.running = false;
    this.tui.stop();
  }
}
