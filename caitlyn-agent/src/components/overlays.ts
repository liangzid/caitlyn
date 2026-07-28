/**
 * CAITLYN TUI Overlay Builders
 *
 * Standalone functions that build overlay components (dashboards, pickers, etc.).
 * Extracted from caitlyn-tui.ts to keep the main class focused on interaction flow.
 */

import {
  Box,
  Text,
  SelectList,
  type Component,
} from "@earendil-works/pi-tui";
import { getDashboard, loadHistory } from "../history.js";
import {
  loadAntibodies,
  loadAntigens,
  loadAntibodyIndex,
  buildAntibodyIndex,
} from "../library.js";
import { getProviders, getModels } from "../llm.js";
import { getContextWindow, getModelDisplay } from "../config/models.js";
import { C, selectListTheme } from "../theme.js";

// ── Overlay Helpers ───────────────────────────────────────────────

// ── Glass-morphism background for overlays ──────────────────────────
const overlayBg = (text: string) => `\x1b[48;5;236m\x1b[37m${text}\x1b[0m`;

export function makeBox(title: string, lines: string[], maxHeight = 20): Box {
  const box = new Box(1, 1, overlayBg);
  let allLines: string[];
  if (lines.length > maxHeight) {
    allLines = [`${C.bold}${C.cyan}${title}${C.reset}`, "", ...lines.slice(0, maxHeight - 3), `${C.dim}(scroll for more)${C.reset}`];
  } else {
    allLines = [`${C.bold}${C.cyan}${title}${C.reset}`, "", ...lines];
  }
  box.addChild(new Text(allLines.join("\n")));
  return box;
}

// ── Overlay Builders ──────────────────────────────────────────────

export function buildDashboardOverlay(): Component {
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

export function buildStatusOverlay(): Component {
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

export function buildHistoryOverlay(): Component {
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

export function buildSessionPickerOverlay(
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
