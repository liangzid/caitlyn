/**
 * CAITLYN Footer Component
 *
 * Two-line status bar showing:
 *   Line 1: cwd, git branch, session name  ·  daemon + antibody pills
 *   Line 2: token/cost/context telemetry    ·  model + thinking level
 *
 * Styled with the bioluminescent palette from theme.ts.
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { sep, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { C, PAL, fg, badge, gradText, bar } from "../theme.js";

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

    // ── Line 1 ────────────────────────────────────────────────
    // Left: cwd + git branch + session name
    let left1 = `${fg(PAL.cyan)}◈${C.reset} ${gradText(formatCwd(d.cwd), PAL.cyan, PAL.teal)}`;
    if (d.gitBranch) {
      left1 += `  ${fg(PAL.faint)}⎇${C.reset} ${fg(PAL.dim)}${d.gitBranch}${C.reset}`;
    }
    if (d.sessionName) {
      left1 += `  ${fg(PAL.faint)}◆${C.reset} ${fg(PAL.dim)}${d.sessionName}${C.reset}`;
    }

    // Right: daemon status + antibody count pills
    const daemonPill = d.daemonStatus === "connected"
      ? badge("● DAEMON", PAL.ok, PAL.okBg)
      : d.daemonStatus === "checking"
        ? badge("◌ CHECKING", PAL.warn, PAL.warnBg)
        : badge("○ LOCAL", PAL.faint, PAL.grayBg);
    const abPill = badge(`${d.antibodyCount} AB`, PAL.cyan, PAL.cyanBg);
    const right1 = `${daemonPill} ${abPill}`;

    // ── Line 2 ────────────────────────────────────────────────
    // Left: token telemetry, ordered by priority so narrow widths
    // drop the least important items instead of overflowing.
    const base2: Array<{ text: string; priority: number }> = [];
    base2.push({ text: `${fg(PAL.faint)}⇣${C.reset} ${formatTokens(d.totalInput)}`, priority: 90 });
    base2.push({ text: `${fg(PAL.faint)}⇡${C.reset} ${formatTokens(d.totalOutput)}`, priority: 85 });
    if (d.totalCacheRead > 0) {
      base2.push({ text: `${fg(PAL.faint)}⧉r${C.reset} ${formatTokens(d.totalCacheRead)}`, priority: 50 });
    }
    if (d.totalCacheWrite > 0) {
      base2.push({ text: `${fg(PAL.faint)}⧉w${C.reset} ${formatTokens(d.totalCacheWrite)}`, priority: 45 });
    }
    base2.push({ text: `${fg(PAL.warn)}${formatCost(d.totalCost)}${C.reset}`, priority: 70 });

    // Context window: mini gauge + percent
    if (d.contextPercent !== undefined) {
      const pct = Math.max(0, Math.min(100, d.contextPercent));
      const ctxColor = pct > 90 ? PAL.danger : pct > 70 ? PAL.warn : PAL.ok;
      const autoLabel = d.isAutoCompact ? ` ${fg(PAL.faint)}↻${C.reset}` : "";
      base2.push({
        text: `${bar(pct / 100, 10, ctxColor)}${fg(ctxColor)}${Math.round(pct)}%${C.reset}${autoLabel}`,
        priority: 80,
      });
    }
    base2.sort((a, b) => b.priority - a.priority);

    // Right: model + thinking level (thinking dropped first on narrow widths)
    const rightBase = `${fg(PAL.dim)}${d.currentModel}${C.reset}`;
    const thinkingPart = d.thinkingLevel && d.thinkingLevel !== "off"
      ? ` ${badge(d.thinkingLevel, PAL.violet, PAL.violetBg, false)}`
      : "";
    let right2 = rightBase + thinkingPart;

    let left2 = "";
    for (const item of base2) {
      const joined = left2 === "" ? item.text : `${left2}  ${item.text}`;
      const fits = visibleWidth(joined) <= width - visibleWidth(right2) - 4;
      if (fits) {
        left2 = joined;
        continue;
      }
      // Not enough room with the thinking badge — retry with model only
      right2 = rightBase;
      if (left2 === "" && visibleWidth(item.text) <= width - visibleWidth(right2) - 4) {
        left2 = item.text;
      }
      break;
    }

    // ── Compose with spacing ──────────────────────────────────
    const left1Width = visibleWidth(left1);
    const right1Width = visibleWidth(right1);
    const spacer1 = Math.max(1, width - left1Width - right1Width);
    const left2Width = visibleWidth(left2);
    const right2Width = visibleWidth(right2);
    const spacer2 = Math.max(1, width - left2Width - right2Width);

    return [
      `${fg(PAL.cyan)}▍${C.reset}${fg(PAL.border)}${"─".repeat(Math.max(0, width - 1))}${C.reset}`,
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
