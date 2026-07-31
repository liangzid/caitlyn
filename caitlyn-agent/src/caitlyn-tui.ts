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
import { spawnSync } from "node:child_process";
import {
  TUI,
  Markdown,
  Text,
  ProcessTerminal,
  CancellableLoader,
  Loader,
  Editor,
  matchesKey,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type LlmCallFn } from "./scanner.js";
import { loadConfig } from "./config.js";
import { isDaemonRunning } from "./daemon/index.js";
import { loadAntibodies, loadAntibodyIndex, buildAntibodyIndex } from "./library.js";
import { SessionManager } from "./session/session-manager.js";
import {
  FooterComponent,
  createDefaultFooterData,
  type FooterData,
} from "./components/footer.js";
import { createAutocompleteProvider } from "./commands/slash-commands.js";
import { getContextWindow, getModelDisplay } from "./config/models.js";
import type { MessageEntry } from "./session/session-types.js";
import { C, PAL, fg, paint, badge, gradLines, gradText, gradColorAt, selectListTheme, estimateTokens, translateLlmError } from "./theme.js";
import {
  buildDashboardOverlay,
  buildStatusOverlay,
  buildHistoryOverlay,
  buildModelSelectorOverlay,
} from "./components/overlays.js";
import {
  doScan,
  doAntibodyList,
  doAntibodyAdd,
  doAntibodyRemove,
  doAntigenShow,
  doVaccinate,
  doNewSession,
  doResumeSession,
  doSessionInfo,
  doCompaction,
  showSessionTree,
  doFork,
  doClone,
  doDelete,
  doModelSwitch,
  doLogin,
  showHelp,
} from "./commands/handlers.js";

const noEmoji = process.env.CAITLYN_NO_EMOJI === "1";

// ── Logo ──────────────────────────────────────────────────────────

const CAITLYN_ART = [
  "   ___   _     _____  _____  __         __",
  "  / __\\ /_\\    \\_   \\/__   \\/ //\\_/\\ /\\ \\ \\",
  " / /   //_\\\\    / /\\/  / /\\/ / \\_ _//  \\/ /",
  "/ /___/  _  \\/\\/ /_   / / / /___/ \\/ /\\  /",
  "\\____/\\_/ \\_/\\____/   \\/  \\____/\\_/\\_\\ \\/",
].join("\n");

/** Signature ramp: cyan → teal → violet → magenta (bottom glows pink). */
const LOGO_RAMP = [PAL.cyan, PAL.cyanDeep, PAL.teal, PAL.violetDeep, PAL.violet, PAL.magenta, PAL.pink];

const LOGO_TAGLINES = [
  { text: "AI AGENT IMMUNE SYSTEM", color: PAL.cyan },
  { text: "CONTINUOUS AGENTS FOR INJECTION THREATS", color: PAL.violet },
  { text: "VIA LIFELONG YIELDING NEXUS", color: PAL.magenta },
];

/**
 * Build the glowing CAITLYN emblem: gradient box borders (vertical ramp),
 * per-character gradient on the ASCII art (horizontal ramp), tinted taglines.
 */
function buildLogo(): string {
  const artLines = CAITLYN_ART.split("\n");
  const artW = Math.max(...artLines.map((l) => [...l].length));
  const pad = 2;
  const innerW = artW + pad * 2;

  const total = artLines.length + 2 + 1 + LOGO_TAGLINES.length + 1 + 2; // art + spacers + taglines + rule
  let idx = 0;
  const vColor = () => gradColorAt(LOGO_RAMP, idx++ / (total - 1));
  const line = (content: string, contentW: number) => {
    const c = vColor();
    return `${fg(c)}║${C.reset}${content}${fg(c)}${" ".repeat(Math.max(0, innerW - contentW))}║${C.reset}`;
  };

  const out: string[] = [];
  out.push(`${fg(gradColorAt(LOGO_RAMP, 0))}╔${C.reset}${gradLines("═".repeat(innerW), LOGO_RAMP, false)}${fg(gradColorAt(LOGO_RAMP, 0))}╗${C.reset}`);
  idx = 0;
  out.push(line("", 0));
  for (const a of artLines) {
    out.push(line(` ${gradText(a, PAL.cyan, PAL.magenta, true)} `, artW + 2));
  }
  out.push(line("", 0));
  out.push(`${fg(vColor())}╠${C.reset}${gradLines("═".repeat(innerW), LOGO_RAMP, false)}${fg(vColor())}╣${C.reset}`);
  for (const tag of LOGO_TAGLINES) {
    out.push(line(` ${paint(tag.text, tag.color, undefined, false)} `, [...tag.text].length + 2));
  }
  out.push(`${fg(gradColorAt(LOGO_RAMP, 1))}╚${C.reset}${gradLines("═".repeat(innerW), LOGO_RAMP, false)}${fg(gradColorAt(LOGO_RAMP, 1))}╝${C.reset}`);
  return out.join("\n");
}

const CAITLYN_LOGO = buildLogo();

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


// ── Main TUI ──────────────────────────────────────────────────────

/**
 * Extract text content from an assistant message's content blocks.
 * Handles both streaming deltas (text blocks) and thinking blocks.
 * Exported for testability of the event-handling logic.
 */
export function extractAssistantContent(
  content: unknown,
): string {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((c: unknown) => {
      const t = (c as Record<string, unknown>).type;
      return t === "text" || t === "thinking";
    })
    .map((c: unknown) => {
      const o = c as Record<string, unknown>;
      if ("text" in o && typeof o.text === "string") return o.text;
      if ("content" in o && typeof o.content === "string") return o.content;
      return "";
    })
    .join("");
}

export class CaitlynTUI {
  tui: TUI;
  editor: Editor;
  footer: FooterComponent;
  agent: Agent | null = null;
  llmCall: LlmCallFn;
  sessionMgr: SessionManager;
  private running = false;
  private isResponding = false;
  private commandHistory: string[] = [];
  private historyIndex = -1;
  currentProvider: string;
  currentModelId: string;
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
    // Read provider/model from env vars → config.toml → defaults
    const cfg = loadConfig();
    const provider = cfg.provider;
    const modelId = cfg.model;

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

    footerData.daemonStatus = isDaemonRunning() ? "connected" : "disconnected";
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
      // Esc: universal dismiss / abort (matchesKey handles Kitty protocol)
      if (matchesKey(data, "escape")) {
        if (tui.hasOverlay()) {
          tui.hideOverlay();
          return { consume: true };
        }
        // No overlay: Esc aborts ongoing response
        if (self.isResponding) {
          self.abortResponse();
          return { consume: true };
        }
        // No overlay, not responding: Esc exits
        self.showSystemMessage(`${C.yellow}Goodbye.${C.reset}`);
        self.stop();
        return { consume: true };
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
      // Ctrl+C: dismiss overlay if active, otherwise quit
      if (matchesKey(data, "ctrl+c")) {
        if (tui.hasOverlay()) {
          tui.hideOverlay();
        } else {
          self.stop();
        }
        return { consume: true };
      }
      // Ctrl+L: always clear screen
      if (data === "\x0c") {
        const children = tui.children;
        children.splice(1, children.length - 3);
        tui.requestRender();
        return { consume: true };
      }
      // Ctrl+D: exit when editor is empty, otherwise let editor handle it
      if (matchesKey(data, "ctrl+d")) {
        if (!self.editor.getText().trim() && !self.isResponding) {
          self.showSystemMessage(`${C.yellow}Goodbye.${C.reset}`);
          self.stop();
          return { consume: true };
        }
        // Editor has content — let it handle Ctrl+D (delete forward)
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
          const msg = event.message as unknown as { role?: string; content?: unknown };
          if (msg.role !== "assistant") break;
          const text = extractAssistantContent(msg.content);
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
          const toolLine = `${fg(PAL.warn)}◆${C.reset} ${fg(PAL.dim)}${event.toolName}${C.reset}`;
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
            this.insertBeforeEditor(new Text(`${fg(PAL.faint)}  ↳ ${preview}${C.reset}`));
          }
          break;
        }
        case "message_end": {
          // Only process assistant messages — skip user/system/tool messages
          const msg = event.message as unknown as { role?: string; content?: unknown };
          if (msg.role !== "assistant") break;

          if (this.currentLoader) {
            this.tui.removeChild(this.currentLoader);
            this.currentLoader = null;
          }
          // If no streaming updates fired (non-streaming API), extract content now
          if (!currentMessageContent) {
            const em = event.message as unknown as { errorMessage?: string; stopReason?: string };
            if (em.stopReason === "error" && em.errorMessage) {
              currentMessageContent = `${C.red}⚠️ ${em.errorMessage}${C.reset}`;
            } else {
              currentMessageContent = extractAssistantContent(msg.content);
            }
          }
          // Remove the streaming message so the final message doesn't duplicate
          if (this.streamingMd) {
            this.tui.removeChild(this.streamingMd);
            this.streamingMd = null;
          }

          const prefix = `${fg(PAL.cyan)}▍${C.reset} ${gradText("CAITLYN", PAL.cyan, PAL.violet, true)}  ${fg(PAL.faint)}just now${C.reset}  `;
          const msgMd = new Markdown(prefix + currentMessageContent, 0, 0, THEME);
          this.insertBeforeEditor(msgMd);
          const usage = (event.message as unknown as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost: { total: number } } }).usage;
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
          if (this.streamingMd) {
            this.tui.removeChild(this.streamingMd);
            this.streamingMd = null;
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
    const prefix = `${fg(PAL.cyan)}▍${C.reset} ${gradText("CAITLYN", PAL.cyan, PAL.violet, true)}  ${fg(PAL.violet)}streaming${C.reset}  `;
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
        await doScan(this, args);
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
        if (subCmd === "list") { await doAntibodyList(this); }
        else if (subCmd === "add" && abId) { await doAntibodyAdd(this, abId); }
        else if (subCmd === "remove" && abId) { await doAntibodyRemove(this, abId); }
        else { this.showSystemMessage("Usage: /antibody list | add <id> | remove <id>"); }
        break;
      }
      case "/antigen": {
        if (!args) { this.showSystemMessage("Usage: /antigen <id>"); return; }
        await doAntigenShow(this, args.trim());
        break;
      }
      case "/vaccinate": {
        if (!args) { this.showSystemMessage("Usage: /vaccinate <pattern>"); return; }
        await doVaccinate(this, args);
        break;
      }

      // ── Session ────────────────────────────────────────────
      case "/new": {
        await doNewSession(this);
        break;
      }
      case "/resume": {
        await doResumeSession(this);
        break;
      }
      case "/session": {
        await doSessionInfo(this);
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
        await doCompaction(this);
        break;
      }
      case "/tree": {
        showSessionTree(this);
        break;
      }
      case "/fork": {
        if (!args) { this.showSystemMessage("Usage: /fork <message-id>"); return; }
        doFork(this, args);
        break;
      }
      case "/clone": {
        doClone(this);
        break;
      }
      case "/delete": {
        doDelete(this);
        break;
      }

      // ── Config ─────────────────────────────────────────────
      case "/model": {
        if (args) {
          await doModelSwitch(this, args);
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
        await doLogin(this, args);
        break;
      }
      case "/settings": {
        this.showSystemMessage("Settings: ~/.caitlyn/config.toml (edit manually)");
        break;
      }

      // ── Meta ────────────────────────────────────────────────
      case "/help": {
        showHelp(this);
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
    await doScan(this, content);
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
    const prefix = `${fg(PAL.ok)}▍${C.reset} ${gradText("YOU", PAL.ok, PAL.teal, true)}  ${fg(PAL.faint)}just now${C.reset}  `;
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

  private async maybeCompact(): Promise<void> {
    const entries = this.sessionMgr.getAllEntries();
    const msgs = entries.filter((e) => e.type === "message") as MessageEntry[];
    const totalTokens = msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const ctxWindow = getContextWindow(this.currentProvider, this.currentModelId);

    if (totalTokens > ctxWindow * 0.7 && msgs.length >= 4) {
      this.footer.update({ isAutoCompact: true });
      await doCompaction(this);
      this.footer.update({ isAutoCompact: false });
    }
  }

  showSystemMessage(content: string): void {
    const md = new Markdown(content, 0, 0, THEME);
    this.insertBeforeEditor(md);
    this.tui.requestRender();
  }


  refreshFooter(): void {
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
    }, 30_000);

    // Welcome messages
    const antibodies = loadAntibodies();
    // Ensure antibody index is valid (rebuild if missing or stale)

    const agentChip = this.agent
      ? badge("● READY", PAL.ok, PAL.okBg)
      : badge("○ OFFLINE", PAL.warn, PAL.warnBg);
    const abChip = badge(`${antibodies.length} ANTIBODIES`, PAL.cyan, PAL.cyanBg);
    const evoChip = badge("EVOLUTION ONLINE", PAL.violet, PAL.violetBg);

    this.showSystemMessage(
      gradText("◈ CAITLYN DEFENSE ONLINE ◈", PAL.cyan, PAL.magenta, true) + "\n\n" +
      `${agentChip} ${abChip} ${evoChip}\n\n` +
      `${fg(PAL.faint)}Type to chat · /scan to inspect · /help for commands · Ctrl+C to exit${C.reset}`,
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
    if (!this.running) return; // idempotent
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
    // Ensure the process exits after cleanup
    setTimeout(() => process.exit(0), 200);
  }
}
