/**
 * CAITLYN Guard — Host-watch dashboard text
 *
 * Live occupancy / network / ACE channels. Shared by CLI and TUI.
 * Does not list processes as the primary view.
 *
 * KEYPOINT FOR 团长 REVIEW: bars are energy / channel threshold, not
 * raw CPU percent. Hot means fusion already fired detect.
 */

import { DEFAULT_OS_ENERGY_CONFIG } from "../guard/os-energy.js";
import type { HostChannelName, HostWatchDashboardView } from "../guard/host-steward.js";

const BAR_WIDTH = 16;
const COMPONENT_THRESHOLD = 1;

/** ASCII energy bar. Ratio is clamped to [0, 1]. */
export function energyBar(score: number, threshold: number): string {
  const cap = Math.max(threshold, 1e-9);
  const ratio = Math.min(1, Math.max(0, score / cap));
  const filled = Math.round(ratio * BAR_WIDTH);
  return `[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}]`;
}

function fmt(n: number | undefined, digits: number = 3): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function channelLine(
  name: HostChannelName,
  score: number,
  threshold: number,
  hot: Set<string>,
): string {
  const mark = hot.has(name) ? "*" : " ";
  return `  ${mark}${name.padEnd(11)} ${energyBar(score, threshold)}  ${fmt(score)}  thr=${fmt(threshold, 2)}`;
}

/**
 * Plain-text host dashboard. No ANSI so CLI and tests can assert it.
 */
export function formatHostWatchDashboard(view: HostWatchDashboardView): string[] {
  const hot = new Set(view.hotChannels);
  const occThr = DEFAULT_OS_ENERGY_CONFIG.energyThreshold;
  const netThr = DEFAULT_OS_ENERGY_CONFIG.energyThreshold;
  const f = view.os.features;
  const lines: string[] = [
    "CAITLYN HOST WATCH",
    "==================",
    `  at: ${view.at}  calibrated: ${view.calibrated}`,
    `  intervention: ${view.intervention}  energy: ${fmt(view.energy)}`,
    `  polls: ${view.polls}  occ_poll: ${view.occupancyPollMs}ms  ace_poll: ${view.componentPollMs}ms`,
    `  tick: ${(view.tickUs / 1000).toFixed(2)}ms  (os ${(view.os.tickUs / 1000).toFixed(2)}ms, ace ${(view.ace.tickUs / 1000).toFixed(2)}ms)`,
    "",
    "CHANNELS",
    channelLine("occupancy", view.channels.occupancy, occThr, hot),
    channelLine("network", view.channels.network, netThr, hot),
    channelLine("component", view.channels.component, COMPONENT_THRESHOLD, hot),
    `  hot: ${view.hotChannels.length > 0 ? view.hotChannels.join(",") : "(none)"}`,
    "",
    "OCCUPANCY",
    `  load1=${fmt(f.load1, 2)}  cpu_busy=${fmt(f.cpuBusy, 2)}  mem=${fmt(f.memUsedRatio, 2)}  processes=${fmt(f.processes, 0)}`,
    "",
    "NETWORK (sockstat inuse, not TLS)",
    `  tcp_sockets=${fmt(f.tcpSockets, 0)}  tcp_established=${fmt(f.tcpEstablished, 0)}`,
    "",
    "COMPONENT (ACE)",
    `  nodes=${view.ace.nodeCount}  mutations=${view.ace.mutationCount}  energy=${fmt(view.ace.energy)}`,
    `  roots: ${view.ace.roots.length > 0 ? view.ace.roots.join(", ") : "(none)"}`,
    `  quarantined: ${view.ace.quarantined.length > 0 ? view.ace.quarantined.join(", ") : "(none)"}`,
    "",
    "INCIDENTS",
  ];
  if (view.incidents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const incident of view.incidents) {
      lines.push(
        `  ${incident.at}  ${incident.hotChannels.join("+")}  ` +
          `occ=${fmt(incident.channels.occupancy)} ` +
          `net=${fmt(incident.channels.network)} ` +
          `ace=${fmt(incident.channels.component)}`,
      );
    }
  }
  return lines;
}
