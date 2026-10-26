/**
 * CAITLYN Guard — Host-watch dashboard rendering
 *
 * Channel energy, sockstat, ACE, incidents. Shared by the snapshot
 * printer and the live TUI. Process lists are not the primary view.
 *
 * KEYPOINT FOR 团长 REVIEW: bars and sparks are energy / threshold,
 * not raw CPU percent. Hot means fusion already fired detect.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_OS_ENERGY_CONFIG } from "../guard/os-energy.js";
import type {
  HostChannelName,
  HostSockstat,
  HostWatchDashboardView,
} from "../guard/host-steward.js";
import { C, PAL, fg, badge, bar, gradText, keycap, panelHeader } from "../theme.js";
import type { DashboardStats } from "../history.js";
import {
  agentWatchStatus,
  type HostProcessInventory,
  type HostProcessRow,
  type ProcSortKey,
} from "../guard/os-process-table.js";

export const OCCUPANCY_THRESHOLD = DEFAULT_OS_ENERGY_CONFIG.energyThreshold;
export const NETWORK_THRESHOLD = DEFAULT_OS_ENERGY_CONFIG.energyThreshold;
export const COMPONENT_THRESHOLD = 1;
export const SPARK_WIDTH = 36;
const SPARK_GLYPHS = "▁▂▃▄▅▆▇█";

export type HostWatchTab = "channels" | "ace" | "scans";

export interface ChannelHistory {
  occupancy: number[];
  network: number[];
  component: number[];
}

export interface HostWatchChrome {
  tab: HostWatchTab;
  paused: boolean;
  refreshMs: number;
  samples: number;
  daemonPid: number | null;
  daemonRssKb: number | null;
  error: string | null;
  inventory: HostProcessInventory | null;
  procSort: ProcSortKey;
  procScroll: number;
  height: number;
}

function fmt(n: number | undefined, digits: number = 3): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "·";
}

function delta(current: number, previous: number | undefined): string {
  if (previous === undefined) return "  Δ ·";
  const d = current - previous;
  if (Math.abs(d) < 1e-4) return "  Δ 0";
  const sign = d > 0 ? "+" : "";
  return `  Δ ${sign}${d.toFixed(3)}`;
}

function channelColor(score: number, threshold: number, hot: boolean): number {
  if (hot) return PAL.danger;
  if (score >= threshold * 0.5) return PAL.warn;
  return PAL.cyan;
}

/** Sparkline over a rolling window. Empty history is faint dots. */
export function sparkline(values: number[], width: number = SPARK_WIDTH): string {
  const w = Math.max(4, width);
  if (values.length === 0) return `${fg(PAL.faint)}${"·".repeat(w)}${C.reset}`;
  const slice = values.slice(-w);
  const pad = w - slice.length;
  const max = Math.max(...slice, 1e-9);
  const glyphs = slice
    .map((v) => {
      const idx = Math.min(
        SPARK_GLYPHS.length - 1,
        Math.max(0, Math.floor((v / max) * (SPARK_GLYPHS.length - 1))),
      );
      return SPARK_GLYPHS[idx];
    })
    .join("");
  return `${fg(PAL.faint)}${"·".repeat(pad)}${C.reset}${fg(PAL.cyan)}${glyphs}${C.reset}`;
}

/** ASCII energy bar for the snapshot printer. */
export function energyBar(score: number, threshold: number): string {
  const cap = Math.max(threshold, 1e-9);
  const ratio = Math.min(1, Math.max(0, score / cap));
  const filled = Math.round(ratio * 16);
  return `[${"#".repeat(filled)}${"-".repeat(16 - filled)}]`;
}

function roomToHot(score: number, threshold: number): string {
  const left = threshold - score;
  if (left <= 0) return "AT THRESHOLD";
  return `${((left / threshold) * 100).toFixed(0)}% to hot`;
}

function optNum(n: number | undefined, digits = 0): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "·";
}

function fmtRss(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)}M`;
  return `${kb}K`;
}

function fmtUptime(sec: number | null): string {
  if (sec == null) return "·";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function sockstatLine(s: HostSockstat): string {
  return (
    `tcp4 ${optNum(s.tcpInuse)}  tcp6 ${optNum(s.tcp6Inuse)}  ` +
    `udp4 ${optNum(s.udpInuse)}  udp6 ${optNum(s.udp6Inuse)}  ` +
    `orphan ${optNum(s.tcpOrphan)}  tw ${optNum(s.tcpTw)}`
  );
}

/**
 * Plain-text snapshot for pipes and tests. No ANSI.
 */
export function formatHostWatchDashboard(view: HostWatchDashboardView): string[] {
  const hot = new Set(view.hotChannels);
  const f = view.os.features;
  const mark = (name: HostChannelName) => (hot.has(name) ? "*" : " ");
  return [
    "CAITLYN HOST WATCH",
    "==================",
    `  at: ${view.at}  calibrated: ${view.calibrated}`,
    `  intervention: ${view.intervention}  energy: ${fmt(view.energy)}`,
    `  polls: ${view.polls}  occ_poll: ${view.occupancyPollMs}ms  ace_poll: ${view.componentPollMs}ms`,
    `  tick: ${(view.tickUs / 1000).toFixed(2)}ms  (os ${(view.os.tickUs / 1000).toFixed(2)}ms, ace ${(view.ace.tickUs / 1000).toFixed(2)}ms)`,
    "",
    "CHANNELS",
    `  ${mark("occupancy")}occupancy   ${energyBar(view.channels.occupancy, OCCUPANCY_THRESHOLD)}  ${fmt(view.channels.occupancy)}  thr=${fmt(OCCUPANCY_THRESHOLD, 2)}`,
    `  ${mark("network")}network     ${energyBar(view.channels.network, NETWORK_THRESHOLD)}  ${fmt(view.channels.network)}  thr=${fmt(NETWORK_THRESHOLD, 2)}`,
    `  ${mark("component")}component   ${energyBar(view.channels.component, COMPONENT_THRESHOLD)}  ${fmt(view.channels.component)}  thr=${fmt(COMPONENT_THRESHOLD, 2)}`,
    `  hot: ${view.hotChannels.length > 0 ? view.hotChannels.join(",") : "(none)"}`,
    "",
    "OCCUPANCY",
    `  load1=${fmt(f.load1, 2)}  cpu_busy=${fmt(f.cpuBusy, 2)}  mem=${fmt(f.memUsedRatio, 2)}  processes=${fmt(f.processes, 0)}`,
    "",
    "NETWORK (sockstat, not TLS)",
    `  ${sockstatLine(view.sockstat ?? {})}`,
    `  tcp_sockets=${fmt(f.tcpSockets, 0)}  tcp_established=${fmt(f.tcpEstablished, 0)}`,
    "",
    "COMPONENT (ACE)",
    `  nodes=${view.ace.nodeCount}  mutations=${view.ace.mutationCount}  energy=${fmt(view.ace.energy)}`,
    `  roots: ${view.ace.roots.length > 0 ? view.ace.roots.join(", ") : "(none)"}`,
    `  quarantined: ${view.ace.quarantined.length > 0 ? view.ace.quarantined.join(", ") : "(none)"}`,
    "",
    "INCIDENTS",
    ...(view.incidents.length === 0
      ? ["  (none)"]
      : view.incidents.map(
          (incident) =>
            `  ${incident.at}  ${incident.hotChannels.join("+")}  ` +
            `occ=${fmt(incident.channels.occupancy)} ` +
            `net=${fmt(incident.channels.network)} ` +
            `ace=${fmt(incident.channels.component)}`,
        )),
  ];
}

/** Fit one TUI line: never wider than `width` visible columns. */
export function fitDashboardLine(text: string, width: number): string {
  const cap = Math.max(1, width);
  if (visibleWidth(text) <= cap) {
    return text + " ".repeat(cap - visibleWidth(text));
  }
  return truncateToWidth(text, cap, "", true);
}

function renderChannelBlock(
  label: string,
  score: number,
  threshold: number,
  series: number[],
  hot: boolean,
  sparkW: number,
  extra: string,
): string[] {
  const color = channelColor(score, threshold, hot);
  const tag = hot ? badge("HOT", PAL.ghost, PAL.dangerBg) : badge("quiet", PAL.dim, PAL.grayBg, false);
  const prev = series.length >= 2 ? series[series.length - 2] : undefined;
  const ratio = Math.min(1, score / Math.max(threshold, 1e-9));
  return [
    `${tag} ${fg(color)}${C.bold}${label.padEnd(11)}${C.reset} ` +
      `${bar(ratio, 18, color)} ${fg(PAL.ghost)}${fmt(score)}${C.reset}` +
      `${fg(PAL.faint)}/${fmt(threshold, 2)}${C.reset}` +
      `${fg(PAL.dim)}${delta(score, prev)}${C.reset}  ${fg(PAL.faint)}${roomToHot(score, threshold)}${C.reset}`,
    `     ${sparkline(series, sparkW)}  ${fg(PAL.text)}${extra}${C.reset}`,
  ];
}

function renderStatusRow(view: HostWatchDashboardView, chrome: HostWatchChrome): string {
  const posture =
    view.intervention === "detect"
      ? badge("DETECT", PAL.ghost, PAL.dangerBg)
      : badge("WATCHING", PAL.ghost, PAL.okBg);
  const cal = view.calibrated
    ? badge("CALIBRATED", PAL.cyan, PAL.cyanBg)
    : badge("WARMING", PAL.warn, PAL.warnBg);
  const rss =
    chrome.daemonRssKb != null
      ? `${(chrome.daemonRssKb / 1024).toFixed(1)} MiB`
      : "·";
  const pid = chrome.daemonPid != null ? String(chrome.daemonPid) : "·";
  return (
    `${posture} ${cal}  ${fg(PAL.faint)}daemon${C.reset} ${fg(PAL.ghost)}${pid}${C.reset}` +
    `  ${fg(PAL.faint)}rss${C.reset} ${fg(PAL.ghost)}${rss}${C.reset}` +
    `  ${fg(PAL.faint)}tick${C.reset} ${fg(PAL.ghost)}${(view.tickUs / 1000).toFixed(2)}ms${C.reset}` +
    `  ${fg(PAL.faint)}polls${C.reset} ${fg(PAL.ghost)}${view.polls}${C.reset}`
  );
}

function renderChannelsTab(
  view: HostWatchDashboardView,
  history: ChannelHistory,
  sparkW: number,
  width: number,
): string[] {
  const hot = new Set(view.hotChannels);
  const f = view.os.features;
  const occExtra =
    `load1 ${fmt(f.load1, 2)}   cpu ${fmt(f.cpuBusy, 2)}   mem ${fmt(f.memUsedRatio, 2)}   procs ${fmt(f.processes, 0)}`;
  const netExtra = sockstatLine(view.sockstat ?? {});
  const aceExtra =
    `nodes ${view.ace.nodeCount}   mutations ${view.ace.mutationCount}   ace-tick ${(view.ace.tickUs / 1000).toFixed(2)}ms`;
  const lines = [
    panelHeader("CHANNELS", width),
    ...renderChannelBlock(
      "OCCUPANCY",
      view.channels.occupancy,
      OCCUPANCY_THRESHOLD,
      history.occupancy,
      hot.has("occupancy"),
      sparkW,
      occExtra,
    ),
    ...renderChannelBlock(
      "NETWORK",
      view.channels.network,
      NETWORK_THRESHOLD,
      history.network,
      hot.has("network"),
      sparkW,
      netExtra,
    ),
    ...renderChannelBlock(
      "COMPONENT",
      view.channels.component,
      COMPONENT_THRESHOLD,
      history.component,
      hot.has("component"),
      sparkW,
      aceExtra,
    ),
    panelHeader("INCIDENTS", width),
  ];
  if (view.incidents.length === 0) {
    lines.push(`${fg(PAL.faint)}  fusion has not fired detect on this host yet${C.reset}`);
  } else {
    for (const incident of view.incidents.slice(-6)) {
      lines.push(
        `  ${fg(PAL.danger)}◆${C.reset} ${fg(PAL.dim)}${incident.at.replace("T", " ").slice(0, 19)}${C.reset}` +
          `  ${fg(PAL.magenta)}${incident.hotChannels.join(" + ")}${C.reset}` +
          `  occ ${fmt(incident.channels.occupancy)}  net ${fmt(incident.channels.network)}  ace ${fmt(incident.channels.component)}`,
      );
    }
  }
  return lines;
}

function renderAceTab(view: HostWatchDashboardView, width: number): string[] {
  const lines = [
    panelHeader("ACE COMPONENT GRAPH", width),
    `  ${fg(PAL.faint)}energy${C.reset} ${fg(PAL.ghost)}${fmt(view.ace.energy)}${C.reset}` +
      `   ${fg(PAL.faint)}nodes${C.reset} ${fg(PAL.ghost)}${view.ace.nodeCount}${C.reset}` +
      `   ${fg(PAL.faint)}mutations this tick${C.reset} ${fg(PAL.ghost)}${view.ace.mutationCount}${C.reset}` +
      `   ${fg(PAL.faint)}ace tick${C.reset} ${fg(PAL.ghost)}${(view.ace.tickUs / 1000).toFixed(2)}ms${C.reset}`,
    `  ${view.ace.calibrated ? badge("ACE BASELINED", PAL.cyan, PAL.cyanBg) : badge("ACE BASELINE PENDING", PAL.warn, PAL.warnBg)}` +
      `  ${view.ace.intervention === "detect" ? badge("GRAFT DETECT", PAL.ghost, PAL.dangerBg) : badge("GRAPH QUIET", PAL.ok, PAL.okBg)}`,
    "",
    `${fg(PAL.dim)}  Möbius/AbO grafts show up here, not in occupancy.${C.reset}`,
    "",
    panelHeader("ROOTS", width),
  ];
  if (view.ace.roots.length === 0) {
    lines.push(`${fg(PAL.faint)}  (no component roots resolved)${C.reset}`);
  } else {
    for (const root of view.ace.roots) {
      lines.push(`  ${fg(PAL.cyan)}◆${C.reset} ${fg(PAL.text)}${root}${C.reset}`);
    }
  }
  lines.push("");
  lines.push(panelHeader("QUARANTINED GRAFTS", width));
  if (view.ace.quarantined.length === 0) {
    lines.push(`${fg(PAL.faint)}  (none — skill/MCP/command grafts would land here)${C.reset}`);
  } else {
    for (const path of view.ace.quarantined) {
      lines.push(`  ${fg(PAL.danger)}◆${C.reset} ${fg(PAL.text)}${path}${C.reset}`);
    }
  }
  return lines;
}

function renderScansTab(stats: DashboardStats | null, width: number): string[] {
  if (!stats || stats.total_scans === 0) {
    return [
      panelHeader("SCAN TELEMETRY", width),
      `${fg(PAL.faint)}  no scan history on this machine yet${C.reset}`,
    ];
  }
  const rate = stats.detection_rate;
  const rateColor = rate > 0.3 ? PAL.danger : rate > 0.1 ? PAL.warn : PAL.ok;
  const tierTotal = stats.tier0_hits + stats.tier1_hits || 1;
  const lines = [
    panelHeader("SCAN TELEMETRY", width),
    `  ${fg(PAL.faint)}scans${C.reset} ${fg(PAL.ghost)}${stats.total_scans}${C.reset}` +
      `   ${fg(PAL.faint)}detected${C.reset} ${fg(PAL.danger)}${stats.malicious_count}${C.reset}` +
      `   ${fg(PAL.faint)}clean${C.reset} ${fg(PAL.ok)}${stats.benign_count}${C.reset}` +
      `   ${fg(PAL.faint)}rate${C.reset} ${fg(rateColor)}${(rate * 100).toFixed(1)}%${C.reset}`,
    `  ${fg(PAL.faint)}detection${C.reset} ${bar(rate, 24, rateColor)}`,
    `  ${fg(PAL.faint)}t0${C.reset} ${bar(stats.tier0_hits / tierTotal, 14, PAL.cyan)} ${fg(PAL.ghost)}${stats.tier0_hits}${C.reset}` +
      `   ${fg(PAL.faint)}t1${C.reset} ${bar(stats.tier1_hits / tierTotal, 14, PAL.violet)} ${fg(PAL.ghost)}${stats.tier1_hits}${C.reset}`,
    `  ${fg(PAL.faint)}latency${C.reset} ${fg(PAL.ghost)}${stats.avg_latency_ms.toFixed(0)}ms${C.reset}` +
      `   ${fg(PAL.faint)}avg tokens${C.reset} ${fg(PAL.ghost)}${stats.avg_tokens.toFixed(0)}${C.reset}`,
  ];
  if (stats.top_defense_skills.length > 0) {
    lines.push("");
    lines.push(panelHeader("TOP DEFENSE SKILLS", width));
    const maxHits = stats.top_defense_skills[0]?.hits ?? 1;
    for (const skill of stats.top_defense_skills.slice(0, 8)) {
      lines.push(
        `  ${fg(PAL.violet)}◆${C.reset} ${fg(PAL.text)}${skill.id}${C.reset}  ` +
          `${bar(skill.hits / maxHits, 12, PAL.violet)} ${fg(PAL.ghost)}${skill.hits}${C.reset}`,
      );
    }
  }
  return lines;
}

function tabHint(tab: HostWatchTab, id: HostWatchTab, label: string): string {
  if (tab === id) return badge(label, PAL.ghost, PAL.violetBg);
  return `${fg(PAL.faint)}${label}${C.reset}`;
}

function renderMeters(view: HostWatchDashboardView, chrome: HostWatchChrome): string[] {
  const inv = chrome.inventory;
  const load = inv?.load;
  const mem = inv?.mem;
  const memUsed = mem ? (mem.memTotalKb - mem.memAvailableKb) / mem.memTotalKb : undefined;
  const cpu = view.os.features.cpuBusy;
  const files =
    inv?.openFiles != null
      ? `${inv.openFiles}${inv.fileMax != null ? `/${inv.fileMax}` : ""}`
      : "·";
  return [
    `  ${fg(PAL.faint)}uptime${C.reset} ${fg(PAL.ghost)}${fmtUptime(inv?.uptimeSec ?? null)}${C.reset}` +
      `  ${fg(PAL.faint)}load${C.reset} ${fg(PAL.ghost)}${fmt(load?.load1, 2)} ${fmt(load?.load5, 2)} ${fmt(load?.load15, 2)}${C.reset}` +
      `  ${fg(PAL.faint)}run${C.reset} ${fg(PAL.ghost)}${load?.runnable ?? "·"}/${load?.processes ?? "·"}${C.reset}` +
      `  ${fg(PAL.faint)}/proc${C.reset} ${fg(PAL.ghost)}${inv?.procDirs ?? "·"}${C.reset}` +
      `  ${fg(PAL.faint)}scan${C.reset} ${fg(PAL.ghost)}${inv ? `${inv.scanMs}ms` : "·"}${C.reset}` +
      `  ${fg(PAL.faint)}fds${C.reset} ${fg(PAL.ghost)}${files}${C.reset}`,
    `  ${fg(PAL.faint)}cpu${C.reset} ${bar(cpu ?? 0, 28, PAL.cyan)} ${fg(PAL.ghost)}${fmt(cpu, 2)}${C.reset}` +
      `  ${fg(PAL.faint)}mem${C.reset} ${bar(memUsed ?? 0, 28, PAL.violet)} ${fg(PAL.ghost)}${fmt(memUsed, 2)}${C.reset}` +
      (mem
        ? ` ${fg(PAL.dim)}${fmtRss(mem.memTotalKb - mem.memAvailableKb)}/${fmtRss(mem.memTotalKb)}${C.reset}`
        : ""),
  ];
}

function statusBadge(status: ReturnType<typeof agentWatchStatus>): string {
  switch (status) {
    case "safe":
      return badge("SAFE", PAL.ghost, PAL.okBg);
    case "daemon":
      return badge("DAEMON", PAL.ghost, PAL.cyanBg);
    case "graft":
      return badge("GRAFT", PAL.ghost, PAL.dangerBg);
    default:
      return badge("WARMING", PAL.ghost, PAL.warnBg);
  }
}

function renderSafeAgentWindow(
  chrome: HostWatchChrome,
  view: HostWatchDashboardView,
  width: number,
): string[] {
  const lines = [
    panelHeader("SAFE AGENTS", width),
    `${fg(PAL.faint)}  under Caitlyn watch · SAFE is steward-quiet, not a malware verdict${C.reset}`,
  ];
  const agents = (chrome.inventory?.rows ?? []).filter((row) => row.agent);
  if (agents.length === 0) {
    lines.push(`${fg(PAL.faint)}  no tagged agent runtimes in the current top slice${C.reset}`);
    return lines;
  }
  for (const row of agents.slice(0, 12)) {
    const status = agentWatchStatus(row, {
      daemonPid: chrome.daemonPid,
      aceDetect: view.ace.intervention === "detect",
      calibrated: view.ace.calibrated,
    });
    const cmd = row.cmdline.length > 0 ? row.cmdline : row.comm;
    const clip = cmd.length > Math.max(24, width - 36) ? `${cmd.slice(0, Math.max(21, width - 39))}…` : cmd;
    lines.push(
      `  ${statusBadge(status)} ${fg(PAL.dim)}${String(row.pid).padStart(7)}${C.reset}` +
        ` ${fg(PAL.ghost)}${fmtRss(row.rssKb).padStart(6)}${C.reset}` +
        ` ${fg(PAL.text)}${clip}${C.reset}`,
    );
  }
  return lines;
}

function joinColumns(left: string[], right: string[], leftW: number, totalW: number): string[] {
  const rule = `${fg(PAL.border)}│${C.reset}`;
  const rightW = Math.max(24, totalW - leftW - 1);
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(
      fitDashboardLine(
        fitDashboardLine(left[i] ?? "", leftW) + rule + fitDashboardLine(right[i] ?? "", rightW),
        totalW,
      ),
    );
  }
  return out;
}

function renderProcessTable(chrome: HostWatchChrome, width: number, rowBudget: number): string[] {
  const inv = chrome.inventory;
  const sortMark = chrome.procSort === "cpu" ? "CPU" : "RSS";
  const head = panelHeader(`PROCESSES sort=${sortMark}`, width);
  if (!inv) {
    return [head, `${fg(PAL.faint)}  process inventory not ready${C.reset}`];
  }
  const header =
    `${fg(PAL.faint)}` +
    `PID`.padStart(7) +
    ` ${"PPID".padStart(7)} ${"RSS".padStart(6)} ${"CPU%".padStart(6)} ${"THR".padStart(4)} S ` +
    `COMM             COMMAND${C.reset}`;
  const start = Math.max(0, chrome.procScroll);
  const slice = inv.rows.slice(start, start + Math.max(3, rowBudget));
  const lines = [head, header];
  const cmdBudget = Math.max(16, width - 56);
  for (const row of slice) {
    const tag = row.agent ? badge("AGENT", PAL.ghost, PAL.violetBg) : "";
    const cpu = row.cpuPct == null ? "   ·  " : row.cpuPct.toFixed(1).padStart(6);
    const cpuColor = (row.cpuPct ?? 0) > 50 ? PAL.danger : (row.cpuPct ?? 0) > 15 ? PAL.warn : PAL.text;
    const commColor = row.pid === chrome.daemonPid ? PAL.cyan : row.agent ? PAL.violet : PAL.text;
    const comm = row.comm.slice(0, 16).padEnd(16);
    const cmd = (row.cmdline || row.comm).slice(0, cmdBudget);
    lines.push(
      `${fg(PAL.dim)}${String(row.pid).padStart(7)}${C.reset}` +
        ` ${fg(PAL.faint)}${String(row.ppid).padStart(7)}${C.reset}` +
        ` ${fg(PAL.ghost)}${fmtRss(row.rssKb).padStart(6)}${C.reset}` +
        ` ${fg(cpuColor)}${cpu}${C.reset}` +
        ` ${fg(PAL.dim)}${String(row.threads).padStart(4)}${C.reset}` +
        ` ${fg(PAL.dim)}${row.state}${C.reset} ` +
        `${fg(commColor)}${comm}${C.reset} ${fg(PAL.text)}${cmd}${C.reset} ${tag}`,
    );
  }
  if (inv.rows.length > slice.length + start) {
    lines.push(`${fg(PAL.faint)}  … ${inv.rows.length - start - slice.length} more  j/k to scroll${C.reset}`);
  }
  return lines;
}

function renderFooter(chrome: HostWatchChrome): string {
  const pause = chrome.paused
    ? badge("PAUSED", PAL.warn, PAL.warnBg)
    : badge("LIVE", PAL.ok, PAL.okBg);
  return (
    `${tabHint(chrome.tab, "channels", "1 host")}  ` +
    `${tabHint(chrome.tab, "ace", "2 ace")}  ` +
    `${tabHint(chrome.tab, "scans", "3 scans")}   ${pause}  ` +
    `${fg(PAL.faint)}${(chrome.refreshMs / 1000).toFixed(1)}s${C.reset}  ` +
    `${fg(PAL.faint)}${chrome.samples} samples${C.reset}   ` +
    `${keycap("space")} pause  ${keycap("+")}/${keycap("-")} rate  ${keycap("q")} quit`
  );
}

function fillHeight(lines: string[], width: number, height: number): string[] {
  const h = Math.max(lines.length, height);
  const out = lines.slice();
  while (out.length < h) out.push(fitDashboardLine("", width));
  return out.slice(0, h);
}

/**
 * Themed live-frame lines. Fills the terminal height like htop.
 */
export function renderHostWatchLiveLines(
  view: HostWatchDashboardView | null,
  history: ChannelHistory,
  chrome: HostWatchChrome,
  stats: DashboardStats | null,
  width: number,
): string[] {
  const inner = Math.max(40, width);
  const sparkW = Math.min(SPARK_WIDTH, Math.max(16, Math.floor(inner / 3)));
  const title = gradText("CAITLYN HOST WATCH", PAL.cyan, PAL.magenta, true);
  const head: string[] = [
    panelHeader("HOST WATCH", inner),
    `  ${title}  ${fg(PAL.faint)}detect-only · no kill${C.reset}`,
  ];
  if (chrome.error) {
    head.push(`  ${badge("OFFLINE", PAL.ghost, PAL.dangerBg)} ${fg(PAL.warn)}${chrome.error}${C.reset}`);
  }
  if (!view) {
    const waiting = [...head, `  ${fg(PAL.faint)}waiting for daemon snapshot…${C.reset}`, "", renderFooter(chrome)];
    return fillHeight(waiting.map((line) => fitDashboardLine(line, inner)), inner, chrome.height);
  }
  const status = [`  ${renderStatusRow(view, chrome)}`, ...renderMeters(view, chrome)];
  let body: string[];
  if (chrome.tab === "ace") {
    body = renderAceTab(view, inner);
  } else if (chrome.tab === "scans") {
    body = renderScansTab(stats, inner);
  } else {
    const leftW = inner >= 120 ? Math.floor(inner * 0.58) : inner;
    const sparkLeft = Math.min(SPARK_WIDTH, Math.max(12, leftW - 40));
    const channels = renderChannelsTab(view, history, sparkLeft, leftW);
    const upper =
      inner >= 120
        ? joinColumns(channels, renderSafeAgentWindow(chrome, view, inner - leftW - 1), leftW, inner)
        : [...channels, "", ...renderSafeAgentWindow(chrome, view, inner)];
    const used = head.length + status.length + upper.length + 3;
    const procBudget = Math.max(10, chrome.height - used);
    body = [...upper, "", ...renderProcessTable(chrome, inner, procBudget)];
  }
  const framed = [...head, ...status, "", ...body, "", renderFooter(chrome)].map((line) =>
    fitDashboardLine(line, inner),
  );
  return fillHeight(framed, inner, chrome.height);
}
