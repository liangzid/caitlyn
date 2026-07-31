/**
 * CAITLYN TUI Overlay Builders
 *
 * Standalone functions that build overlay components (dashboards, pickers, etc.).
 * Extracted from caitlyn-tui.ts to keep the main class focused on interaction flow.
 * All panels share the bioluminescent glass style from theme.ts.
 */

import {
  SelectList,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { getDashboard, loadHistory } from "../history.js";
import {
  loadAntibodies,
  loadAntigens,
  loadAntibodyIndex,
  buildAntibodyIndex,
  saveAntibodyIndex,
} from "../library.js";
import { getProviders, getModels } from "../llm.js";
import { getContextWindow, getModelDisplay } from "../config/models.js";
import { detectAgents, isHookInstalled, getWatchDirsForAgents } from "../adapters/registry.js";
import { isDaemonRunning, getDaemonPid } from "../daemon/index.js";
import { getWatchInfo } from "../daemon/client.js";
import {
  C, PAL, fg, paint, badge, bar, gradText,
  selectListTheme, categoryColor, tierColor, verdictMeta,
} from "../theme.js";

import { ScrollableBox } from "./scrollable-overlay.js";

// ── Overlay Helpers ───────────────────────────────────────────────

export function makeBox(title: string, lines: string[], maxHeight = 20): ScrollableBox {
  const visibleLines = Math.min(maxHeight - 4, lines.length + 4);
  return new ScrollableBox(title, lines, Math.max(5, visibleLines));
}

/** A KPI card cell: dim label left, colored bold value right-aligned. */
function kpiCard(label: string, value: string, color: number, cellWidth = 20): string {
  const labelStr = `${fg(PAL.faint)}${label}${C.reset}`;
  const valueStr = `${fg(color)}${C.bold}${value}${C.reset}`;
  const gap = Math.max(2, cellWidth - visibleWidth(labelStr) - visibleWidth(valueStr));
  return labelStr + " ".repeat(gap) + valueStr;
}

/**
 * Guard Status — which agents on this host are detected, whether CAITLYN
 * hooks protect them, which directories are watched, and daemon state.
 * Async: queries the daemon HTTP API for live watch info.
 */
export async function buildGuardOverlay(): Promise<Component> {
  const lines: string[] = [];

  // ── Daemon + watcher pills ────────────────────────────────
  const daemonOn = isDaemonRunning();
  const daemonPill = daemonOn
    ? badge(`● DAEMON pid ${getDaemonPid() ?? "?"}`, PAL.ok, PAL.okBg)
    : badge("○ DAEMON OFFLINE", PAL.faint, PAL.grayBg);
  lines.push(daemonPill);

  const watch = await getWatchInfo();
  if (daemonOn && watch) {
    const watchPill = watch.active
      ? badge(`◉ WATCHING ${watch.dirs.length} DIRS`, PAL.cyan, PAL.cyanBg)
      : badge("○ NOT WATCHING", PAL.warn, PAL.warnBg);
    lines.push(`\n${watchPill}`);
    if (watch.active && watch.dirs.length > 0) {
      lines.push(`${gradText("WATCHED DIRECTORIES", PAL.cyan, PAL.violet, true)}`);
      for (const d of watch.dirs) {
        lines.push(` ${fg(PAL.cyan)}◈${C.reset} ${fg(PAL.text)}${d}${C.reset}`);
      }
      const s = watch.stats;
      if (s) {
        lines.push(
          ` ${fg(PAL.faint)}events ${s.totalEvents} · scanned ${s.filesScanned} · blocked ${fg(PAL.danger)}${s.filesBlocked}${C.reset} · flagged ${fg(PAL.warn)}${s.filesFlagged}${C.reset} · allowed ${fg(PAL.ok)}${s.filesAllowed}${C.reset}`,
        );
      }
    }
  } else {
    lines.push(
      `\n${fg(PAL.faint)}daemon offline — run ${paint(" caitlyn daemon start ", PAL.ghost, PAL.grayBg, true)} for fs-watching${C.reset}`,
    );
  }

  // ── Detected agents + hook state ──────────────────────────
  const detected = detectAgents();
  const watchDirs = getWatchDirsForAgents();
  const present = detected.filter((d) => d.installed);
  lines.push("");
  lines.push(`${gradText("AGENT PROTECTION", PAL.cyan, PAL.violet, true)}`);
  if (present.length === 0) {
    lines.push(` ${fg(PAL.faint)}(no known agents detected on this host)${C.reset}`);
  }
  for (const d of present) {
    const hooked = isHookInstalled(d.agent.id);
    const hookBadge = hooked
      ? badge("HOOKS ✓", PAL.ok, PAL.okBg)
      : badge("HOOKS ✗", PAL.warn, PAL.warnBg);
    const dirs = watchDirs.agentDirs[d.agent.id] ?? [];
    const dirPart = dirs.length > 0
      ? ` ${fg(PAL.faint)}watches: ${dirs.join(", ")}${C.reset}`
      : "";
    lines.push(
      ` ${fg(PAL.cyan)}◆${C.reset} ${fg(PAL.text)}${d.agent.id}${C.reset} ${badge(d.agent.integrationMethod, PAL.violet, PAL.violetBg, false)} ${hookBadge}${dirPart}`,
    );
  }
  const exposed = present.filter((d) => !isHookInstalled(d.agent.id));
  if (exposed.length > 0) {
    lines.push("");
    lines.push(`${fg(PAL.warn)}⚠ exposed:${C.reset} ${exposed.map((d) => d.agent.id).join(", ")} — protect with ${paint(" caitlyn install <id> ", PAL.ghost, PAL.grayBg, true)}`);
  }

  return makeBox("GUARD STATUS", lines, 22);
}

/**
 * Dashboard — defense telemetry in KPI cards, tier-split gauges,
 * performance row, and a top-antibodies ranking.
 */
export function buildDashboardOverlay(): Component {
  const stats = getDashboard();
  if (stats.total_scans === 0) {
    return makeBox("DEFENSE DASHBOARD", [
      `${fg(PAL.faint)}No scan data yet.${C.reset}`,
      "",
      `${fg(PAL.dim)}Run ${paint(" /scan <content> ", PAL.ghost, PAL.grayBg, true)} or a scan via the agent to populate telemetry.${C.reset}`,
    ]);
  }

  const rate = stats.detection_rate;
  const rateColor = rate > 0.3 ? PAL.danger : rate > 0.1 ? PAL.warn : PAL.ok;
  const lines: string[] = [];

  // ── KPI grid (2 cards per row) ─────────────────────────────
  lines.push(
    kpiCard("TOTAL SCANS", String(stats.total_scans), PAL.cyan) +
      kpiCard("THREATS DETECTED", String(stats.malicious_count), PAL.danger),
    kpiCard("CLEAN", String(stats.benign_count), PAL.ok) +
      kpiCard("DETECTION RATE", `${(rate * 100).toFixed(1)}%`, rateColor),
  );
  lines.push(`${fg(PAL.faint)}detection${C.reset} ${bar(rate, 24, rateColor)}`);

  // ── Tier split ─────────────────────────────────────────────
  const t0 = stats.tier0_hits;
  const t1 = stats.tier1_hits;
  const tierTotal = t0 + t1 || 1;
  lines.push("");
  lines.push(`${gradText("TIER SPLIT", PAL.cyan, PAL.violet, true)}`);
  lines.push(
    ` ${fg(tierColor(0))}◆${C.reset} ${fg(PAL.dim)}T0 · deterministic${C.reset}  ${bar(t0 / tierTotal, 14, tierColor(0))} ${fg(PAL.ghost)}${t0}${C.reset}`,
    ` ${fg(tierColor(1))}◆${C.reset} ${fg(PAL.dim)}T1 · LLM verdict${C.reset}  ${bar(t1 / tierTotal, 14, tierColor(1))} ${fg(PAL.ghost)}${t1}${C.reset}`,
  );

  // ── Performance row ────────────────────────────────────────
  lines.push("");
  lines.push(`${gradText("PERFORMANCE", PAL.cyan, PAL.violet, true)}`);
  lines.push(
    ` ${fg(PAL.faint)}latency${C.reset} ${fg(PAL.ghost)}${stats.avg_latency_ms.toFixed(0)}ms${C.reset}` +
      `   ${fg(PAL.faint)}avg tokens${C.reset} ${fg(PAL.ghost)}${stats.avg_tokens.toFixed(0)}${C.reset}` +
      `   ${fg(PAL.faint)}total tokens${C.reset} ${fg(PAL.ghost)}${stats.total_tokens.toLocaleString()}${C.reset}`,
  );

  // ── Top antibodies ─────────────────────────────────────────
  if (stats.top_antibodies.length > 0) {
    lines.push("");
    lines.push(`${gradText("TOP ANTIBODIES", PAL.cyan, PAL.violet, true)}`);
    const maxHits = stats.top_antibodies[0]?.hits ?? 1;
    for (const a of stats.top_antibodies.slice(0, 5)) {
      lines.push(
        ` ${fg(PAL.violet)}◆${C.reset} ${fg(PAL.text)}${a.id}${C.reset}  ${bar(a.hits / maxHits, 10, PAL.violet)} ${fg(PAL.ghost)}${a.hits}${C.reset} ${fg(PAL.faint)}hits${C.reset}`,
      );
    }
  }

  if (stats.last_scan_at) {
    lines.push("");
    lines.push(`${fg(PAL.faint)}last scan  ${stats.last_scan_at.replace("T", " ").slice(0, 19)}${C.reset}`);
  }

  return makeBox("DEFENSE DASHBOARD", lines);
}

/**
 * Status — immune library snapshot: antibody forest with category chips
 * and tier badges, plus antigen counts by category.
 */
export function buildStatusOverlay(): Component {
  const antibodies = loadAntibodies();
  const antigens = loadAntigens();
  let index = loadAntibodyIndex() ?? buildAntibodyIndex(antibodies);

  // If the persisted index is stale (roots no longer resolve), rebuild it
  // from the real forest and persist the healed index.
  if (!index.roots.some((rid) => antibodies.some((a) => a.config.id === rid))) {
    index = buildAntibodyIndex(antibodies);
    saveAntibodyIndex(index);
  }
  const roots = index.roots;

  const lines: string[] = [];
  lines.push(
    `${badge(`${antibodies.length} ANTIBODIES`, PAL.cyan, PAL.cyanBg)}  ${badge(`${antigens.length} ANTIGENS`, PAL.violet, PAL.violetBg)}`,
    "",
    `${gradText("ANTIBODY FOREST", PAL.cyan, PAL.violet, true)}`,
  );

  for (const rid of roots) {
    const ab = antibodies.find((a) => a.config.id === rid);
    if (ab) {
      const tp = ab.config.stats?.true_positives ?? 0;
      const fp = ab.config.stats?.false_positives ?? 0;
      const catColor = categoryColor(ab.config.category);
      const tier = tierColor(ab.config.tier);
      const catBadge = badge(ab.config.category.toUpperCase(), catColor, PAL.panelHi, false);
      const tierBadge = badge(`T${ab.config.tier}`, tier, PAL.panelHi, false);
      const tpPart = tp > 0
        ? ` ${fg(PAL.ok)}TP ${tp}${C.reset}`
        : ` ${fg(PAL.faint)}TP 0${C.reset}`;
      const fpPart = fp > 0
        ? ` ${fg(PAL.danger)}FP ${fp}${C.reset}`
        : ` ${fg(PAL.faint)}FP 0${C.reset}`;
      lines.push(` ${fg(catColor)}◆${C.reset} ${fg(PAL.text)}${ab.config.id}${C.reset}  ${catBadge} ${tierBadge}${tpPart}${fpPart}`);
    }
  }

  if (index.roots.length === 0) {
    lines.push(`  ${fg(PAL.faint)}(none loaded)${C.reset}`);
  }

  lines.push("");
  lines.push(`${gradText("ANTIGENS BY CATEGORY", PAL.cyan, PAL.violet, true)}`);
  const byCat: Record<string, number> = {};
  for (const ag of antigens) byCat[ag.config.category] = (byCat[ag.config.category] || 0) + 1;
  if (Object.keys(byCat).length === 0) {
    lines.push(`  ${fg(PAL.faint)}(none loaded)${C.reset}`);
  }
  const maxCat = Math.max(1, ...Object.values(byCat));
  for (const [cat, count] of Object.entries(byCat)) {
    const cc = categoryColor(cat);
    lines.push(
      ` ${fg(cc)}◆${C.reset} ${fg(PAL.dim)}${cat}${C.reset}  ${bar(count / maxCat, 10, cc)} ${fg(PAL.ghost)}${count}${C.reset}`,
    );
  }

  return makeBox("IMMUNE STATUS", lines);
}

/**
 * History — recent scan log as a color-coded select list:
 * verdict badge, confidence, tier, timestamp, content preview.
 */
export function buildHistoryOverlay(): Component {
  const entries = loadHistory();
  if (entries.length === 0) {
    return makeBox("SCAN HISTORY", ["No scan history yet."]);
  }

  const items = entries.map((e) => {
    const meta = verdictMeta(e.verdict);
    const conf = `${Math.round(e.confidence * 100)}%`;
    const label =
      `${badge(`${meta.icon} ${e.verdict.toUpperCase()}`, meta.fg, meta.bg)} ` +
      `${fg(PAL.dim)}${e.timestamp.replace("T", " ").slice(0, 19)}${C.reset} ` +
      `${badge(`T${e.tier}`, tierColor(e.tier), PAL.panelHi, false)} ` +
      `${fg(PAL.faint)}${conf}${C.reset}  ${fg(PAL.dim)}${e.content_preview}${C.reset}`;
    return { value: e.timestamp, label };
  });

  const list = new SelectList(items, 10, selectListTheme);
  return list;
}

/** Session picker — name + message count badge + updated time. */
export function buildSessionPickerOverlay(
  sessions: Array<{ id: string; name?: string; entryCount: number; updatedAt: number }>,
): Component {
  if (sessions.length === 0) {
    return makeBox("SESSIONS", ["No saved sessions found."]);
  }

  const items = sessions.map((s) => {
    const date = new Date(s.updatedAt).toLocaleString();
    const name = s.name || s.id.slice(0, 20);
    const label =
      `${fg(PAL.cyan)}◈${C.reset} ${fg(PAL.text)}${name}${C.reset} ` +
      `${badge(`${s.entryCount} msgs`, PAL.violet, PAL.violetBg, false)} ` +
      `${fg(PAL.faint)}${date}${C.reset}`;
    return { value: s.id, label };
  });

  const list = new SelectList(items, 8, selectListTheme);
  return list;
}

/** Model selector — provider-colored chips + context window hints. */
export function buildModelSelectorOverlay(): Component {
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
        const providerChip = badge(p, PAL.violet, PAL.violetBg, false);
        items.push({
          value: key,
          label: `${fg(PAL.text)}${display}${C.reset}  ${providerChip}  ${fg(PAL.faint)}${ctxLabel}${C.reset}`,
        });
      }
    } catch { /* skip */ }
  }

  if (items.length === 0) {
    return makeBox("MODEL SELECTOR", [
      "No models configured.",
      "",
      "Set API keys via environment variables or /login <provider>",
    ]);
  }

  const list = new SelectList(items, 10, selectListTheme);
  return list;
}
