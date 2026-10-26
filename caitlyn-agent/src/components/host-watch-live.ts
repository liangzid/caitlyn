/**
 * CAITLYN Guard — Live host-watch TUI
 *
 * Full-screen, refreshing steward view. Keyboard like htop: stay until
 * q. Not a process table.
 *
 * KEYPOINT FOR 团长 REVIEW: this process never kills PIDs. Detect-only.
 */

import * as fs from "node:fs";
import {
  ProcessTerminal,
  TUI,
  matchesKey,
  type Component,
} from "@earendil-works/pi-tui";
import { getHostWatchDashboard } from "../daemon/client.js";
import { getDaemonPid } from "../daemon/lifecycle.js";
import { getDashboard, type DashboardStats } from "../history.js";
import type { HostWatchDashboardView } from "../guard/host-steward.js";
import {
  renderHostWatchLiveLines,
  type ChannelHistory,
  type HostWatchChrome,
  type HostWatchTab,
} from "./host-watch-dashboard.js";

const HISTORY_CAP = 90;
const REFRESH_MIN_MS = 250;
const REFRESH_MAX_MS = 5000;

export interface HostWatchLiveOptions {
  requestRender: () => void;
  isVisible?: () => boolean;
  onQuit?: () => void;
}

/** Read VmRSS for a pid. Missing proc returns null. */
export function readDaemonRssKb(pid: number): number | null {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function emptyHistory(): ChannelHistory {
  return { occupancy: [], network: [], component: [] };
}

function pushSample(history: ChannelHistory, view: HostWatchDashboardView): void {
  history.occupancy.push(view.channels.occupancy);
  history.network.push(view.channels.network);
  history.component.push(view.channels.component);
  if (history.occupancy.length > HISTORY_CAP) history.occupancy.shift();
  if (history.network.length > HISTORY_CAP) history.network.shift();
  if (history.component.length > HISTORY_CAP) history.component.shift();
}

function safeScanStats(): DashboardStats | null {
  try {
    return getDashboard();
  } catch {
    return null;
  }
}

/**
 * Full-frame live dashboard. Polls the daemon; q/Esc quits.
 */
export class HostWatchLiveScreen implements Component {
  children: Component[] = [];
  private opts: HostWatchLiveOptions;
  private view: HostWatchDashboardView | null = null;
  private history = emptyHistory();
  private stats: DashboardStats | null = null;
  private tab: HostWatchTab = "channels";
  private paused = false;
  private refreshMs = 1000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private error: string | null = null;
  private fetchInFlight = false;

  constructor(opts: HostWatchLiveOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.armTimer();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.running) return;
      if (this.opts.isVisible && !this.opts.isVisible()) return;
      if (this.paused) return;
      void this.tick();
    }, this.refreshMs);
  }

  private async tick(): Promise<void> {
    if (this.fetchInFlight) return;
    this.fetchInFlight = true;
    try {
      const next = await getHostWatchDashboard();
      if (next) {
        this.view = next;
        this.error = null;
        pushSample(this.history, next);
      } else if (!this.view) {
        this.error = "daemon snapshot unavailable — caitlyn daemon start";
      }
      this.stats = safeScanStats();
      this.opts.requestRender();
    } finally {
      this.fetchInFlight = false;
    }
  }

  render(width: number): string[] {
    const pid = getDaemonPid();
    const chrome: HostWatchChrome = {
      tab: this.tab,
      paused: this.paused,
      refreshMs: this.refreshMs,
      samples: this.history.occupancy.length,
      daemonPid: pid,
      daemonRssKb: pid != null ? readDaemonRssKb(pid) : null,
      error: this.error,
    };
    return renderHostWatchLiveLines(this.view, this.history, chrome, this.stats, width);
  }

  handleInput(data: string): { consume: boolean } | void {
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.stop();
      this.opts.onQuit?.();
      return { consume: true };
    }
    if (data === " ") {
      this.paused = !this.paused;
      this.opts.requestRender();
      return { consume: true };
    }
    if (data === "1") {
      this.tab = "channels";
      this.opts.requestRender();
      return { consume: true };
    }
    if (data === "2") {
      this.tab = "ace";
      this.opts.requestRender();
      return { consume: true };
    }
    if (data === "3") {
      this.tab = "scans";
      this.opts.requestRender();
      return { consume: true };
    }
    if (data === "+" || data === "=") {
      this.refreshMs = Math.max(REFRESH_MIN_MS, this.refreshMs - 250);
      this.armTimer();
      this.opts.requestRender();
      return { consume: true };
    }
    if (data === "-" || data === "_") {
      this.refreshMs = Math.min(REFRESH_MAX_MS, this.refreshMs + 250);
      this.armTimer();
      this.opts.requestRender();
      return { consume: true };
    }
    return { consume: true };
  }

  invalidate(): void {
    /* TUI calls this after handleInput */
  }
}

/** Standalone htop-style session. Blocks until the user quits. */
export async function runHostWatchLiveApp(): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  tui.setClearOnShrink(false);

  let stopped = false;
  const stopAll = (): void => {
    if (stopped) return;
    stopped = true;
    screen.stop();
    tui.stop();
  };

  const screen = new HostWatchLiveScreen({
    requestRender: () => tui.requestRender(),
    onQuit: stopAll,
  });
  tui.addChild(screen);
  tui.setFocus(screen);
  tui.addInputListener((data: string) => screen.handleInput(data) ?? { consume: true });

  screen.start();
  tui.start();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (stopped) {
        clearInterval(check);
        resolve();
      }
    }, 80);
  });
}
