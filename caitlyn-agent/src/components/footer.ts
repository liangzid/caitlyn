/**
 * CAITLYN Footer Component
 *
 * Two-line status bar showing:
 *   Line 1: cwd (with ~), git branch, session name
 *   Line 2: token stats, cost, context %, model/provider, daemon status
 *
 * Ported from pi coding agent's FooterComponent.
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { sep, relative, resolve } from "node:path";
import { homedir } from "node:os";

// ── Helpers ───────────────────────────────────────────────────────

function formatCwd(cwd: string): string {
  const home = homedir();
  const rel = relative(resolve(home), resolve(cwd));
  if (rel === "" || !rel.startsWith("..")) {
    return rel === "" ? "~" : `~${sep}${rel}`;
  }
  return cwd;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// ── ANSI ──────────────────────────────────────────────────────────

const C = {
  dim:    "\x1b[2m",
  reset:  "\x1b[0m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  bold:   "\x1b[1m",
} as const;

// ── Data Interface ────────────────────────────────────────────────

export interface FooterData {
  // From session token accumulation
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  contextPercent?: number;     // 0-100
  contextTokens?: number;      // estimated context token count
  contextWindow?: number;      // model context window size
  isAutoCompact?: boolean;

  // From agent state
  currentModel: string;
  providerName: string;
  thinkingLevel?: string;

  // From filesystem
  gitBranch?: string;
  cwd: string;

  // CAITLYN-specific
  daemonStatus: "connected" | "disconnected" | "checking";
  antibodyCount: number;
  sessionName?: string;
}

// ── Component ─────────────────────────────────────────────────────

export class FooterComponent implements Component {
  private data: FooterData;
  private dirty = true;

  constructor(data: FooterData) {
    this.data = data;
  }

  update(data: Partial<FooterData>): void {
    Object.assign(this.data, data);
    this.dirty = true;
  }

  getData(): Readonly<FooterData> {
    return this.data;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(width: number): string[] {
    this.dirty = false;
    const d = this.data;

    // Line 1: cwd + git branch + session name
    let left1 = `${C.cyan}${formatCwd(d.cwd)}${C.reset}`;
    if (d.gitBranch) {
      left1 += ` ${C.dim}${d.gitBranch}${C.reset}`;
    }
    if (d.sessionName) {
      left1 += ` ${C.dim}•${C.reset} ${d.sessionName}`;
    }

    // Line 1 right: daemon status + antibody count
    const daemonIcon = d.daemonStatus === "connected" ? `${C.green}●${C.reset}`
      : d.daemonStatus === "checking" ? `${C.yellow}◌${C.reset}`
      : `${C.red}○${C.reset}`;
    const right1 = `${daemonIcon} ${d.antibodyCount} antibodies`;

    // Line 2 left: token stats
    const parts2: string[] = [];
    parts2.push(`${C.dim}↑${C.reset}${formatTokens(d.totalInput)}`);
    parts2.push(`${C.dim}↓${C.reset}${formatTokens(d.totalOutput)}`);
    if (d.totalCacheRead > 0) {
      parts2.push(`${C.dim}R${C.reset}${formatTokens(d.totalCacheRead)}`);
    }
    if (d.totalCacheWrite > 0) {
      parts2.push(`${C.dim}W${C.reset}${formatTokens(d.totalCacheWrite)}`);
    }
    parts2.push(formatCost(d.totalCost));

    // Context window usage
    if (d.contextPercent !== undefined) {
      const ctxColor = d.contextPercent > 90 ? C.red
        : d.contextPercent > 70 ? C.yellow
        : C.green;
      const autoLabel = d.isAutoCompact ? " (auto)" : "";
      parts2.push(
        `${ctxColor}${d.contextPercent}%${C.reset}/${formatTokens(d.contextTokens ?? 0)}k${C.dim}${autoLabel}${C.reset}`,
      );
    }

    const left2 = parts2.join("  ");

    // Line 2 right: model/provider/thinking
    let right2 = `${C.dim}${d.currentModel}${C.reset}`;
    if (d.thinkingLevel && d.thinkingLevel !== "off") {
      right2 += ` ${C.yellow}${d.thinkingLevel}${C.reset}`;
    }

    // Render two lines with spacing
    const left1Width = visibleWidth(left1);
    const right1Width = visibleWidth(right1);
    const spacer1 = Math.max(1, width - left1Width - right1Width);
    const left2Width = visibleWidth(left2);
    const right2Width = visibleWidth(right2);
    const spacer2 = Math.max(1, width - left2Width - right2Width);

    return [
      `${C.dim}${"─".repeat(width)}${C.reset}`,
      `${left1}${" ".repeat(spacer1)}${right1}`,
      `${left2}${" ".repeat(spacer2)}${right2}`,
    ];
  }
}

/** Create default footer data for the given cwd. */
export function createDefaultFooterData(cwd: string): FooterData {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    currentModel: "unknown",
    providerName: "unknown",
    cwd,
    daemonStatus: "checking",
    antibodyCount: 0,
  };
}
