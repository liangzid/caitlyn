/**
 * CAITLYN Daemon — HTTP Client
 *
 * Used by CLI and TUI to communicate with the running daemon.
 * All methods auto-detect whether the daemon is available.
 */

import type { ScanResult } from "../schema.js";
import type { DaemonStatus } from "./server.js";
import { isDaemonRunning } from "./lifecycle.js";

const DAEMON_URL = "http://127.0.0.1:9070";

// ── Types ───────────────────────────────────────────────────────────

export interface DaemonHealth {
  status: string;
  uptime_ms: number;
}

export interface WatchInfo {
  dirs: string[];
  active: boolean;
  stats: {
    totalEvents: number;
    filesScanned: number;
    filesBlocked: number;
    filesFlagged: number;
    filesAllowed: number;
  } | null;
}

// ── Client ──────────────────────────────────────────────────────────

/** Check if the daemon is reachable. */
export async function isDaemonAvailable(): Promise<boolean> {
  if (!isDaemonRunning()) return false;
  try {
    const res = await fetch(`${DAEMON_URL}/v1/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Get daemon health. */
export async function getHealth(): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${DAEMON_URL}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as DaemonHealth;
  } catch {
    return null;
  }
}

/** Scan content through the daemon. */
export async function daemonScan(content: string): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${DAEMON_URL}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ScanResult;
  } catch {
    return null;
  }
}

/** Get daemon status. */
export async function getDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`${DAEMON_URL}/v1/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

/** Tell the daemon to start watching directories. */
export async function daemonWatch(dirs: string[]): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/v1/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dirs }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Get current watch status from daemon. */
export async function getWatchInfo(): Promise<WatchInfo | null> {
  try {
    const res = await fetch(`${DAEMON_URL}/v1/watch`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as WatchInfo;
  } catch {
    return null;
  }
}

/** Tell the daemon to stop watching. */
export async function daemonUnwatch(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/v1/watch`, {
      method: "DELETE",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
