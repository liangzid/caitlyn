/**
 * CAITLYN Guard — OS occupancy probe
 *
 * Linux procfs readers for load, CPU, and memory. Parsers take text so
 * tests can use recorded /proc snapshots. Collection never invents values:
 * a missing file is omitted, not filled with a placeholder.
 */

import * as fs from "node:fs";
import type { StatsEvent } from "../evolution/stats-collector.js";

/** Read one procfs path. Returns null when the file is absent or unreadable. */
export type ProcFileReader = (path: string) => string | null;

/** Cumulative CPU jiffies from the first `cpu ` line of /proc/stat. */
export interface CpuStat {
  idle: number;
  total: number;
}

/** Load and process-table size from /proc/loadavg. */
export interface LoadavgStat {
  load1: number;
  load5: number;
  load15: number;
  runnable: number;
  processes: number;
}

/** Memory totals from /proc/meminfo, in kibibytes. */
export interface MeminfoStat {
  memTotalKb: number;
  memAvailableKb: number;
}

/** Feature vector used by OS-graph energy. Absent fields stay undefined. */
export interface OccupancyFeatures {
  load1?: number;
  cpuBusy?: number;
  memUsedRatio?: number;
  processes?: number;
}

/**
 * Default reader: real filesystem, no fallback numbers.
 */
export function readProcFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parse the aggregate `cpu ` line of /proc/stat.
 * Fields: user nice system idle iowait irq softirq steal guest guest_nice.
 */
export function parseProcStatCpu(text: string): CpuStat | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("cpu ")) continue;
    const parts = line.trim().split(/\s+/).slice(1);
    if (parts.length < 4) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const idle = nums[3] + (nums[4] ?? 0);
    const total = nums.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    return { idle, total };
  }
  return null;
}

/**
 * Busy ratio from two cumulative CPU samples. Returns null if the
 * counter did not advance (zero or negative delta).
 */
export function cpuBusyRatio(prev: CpuStat, next: CpuStat): number | null {
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  if (totalDelta <= 0) return null;
  const busy = 1 - idleDelta / totalDelta;
  if (!Number.isFinite(busy)) return null;
  return Math.min(1, Math.max(0, busy));
}

/**
 * Parse `/proc/loadavg`: `0.12 0.07 0.01 1/234 12345`.
 */
export function parseProcLoadavg(text: string): LoadavgStat | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length < 4) return null;
  const load1 = Number(fields[0]);
  const load5 = Number(fields[1]);
  const load15 = Number(fields[2]);
  const slash = fields[3].split("/");
  if (slash.length !== 2) return null;
  const runnable = Number(slash[0]);
  const processes = Number(slash[1]);
  if (![load1, load5, load15, runnable, processes].every(Number.isFinite)) {
    return null;
  }
  return { load1, load5, load15, runnable, processes };
}

/**
 * Parse MemTotal and MemAvailable from /proc/meminfo.
 */
export function parseProcMeminfo(text: string): MeminfoStat | null {
  let memTotalKb: number | undefined;
  let memAvailableKb: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === "MemTotal") memTotalKb = value;
    else memAvailableKb = value;
  }
  if (memTotalKb === undefined || memAvailableKb === undefined) return null;
  if (memTotalKb <= 0) return null;
  return { memTotalKb, memAvailableKb };
}

/**
 * Collect occupancy features and stats events from a procfs reader.
 * cpuBusy is only set when `prevCpu` is provided and the counter advanced.
 */
export function collectOccupancyMetrics(
  reader: ProcFileReader = readProcFile,
  prevCpu: CpuStat | null = null,
  at: string = new Date().toISOString(),
): {
  features: OccupancyFeatures;
  events: StatsEvent[];
  cpu: CpuStat | null;
} {
  const features: OccupancyFeatures = {};
  const events: StatsEvent[] = [];

  const loadText = reader("/proc/loadavg");
  if (loadText !== null) {
    const load = parseProcLoadavg(loadText);
    if (load) {
      features.load1 = load.load1;
      features.processes = load.processes;
      events.push(occupancyEvent("load1", load.load1, at));
      events.push(occupancyEvent("load5", load.load5, at));
      events.push(occupancyEvent("load15", load.load15, at));
      events.push(occupancyEvent("processes", load.processes, at));
    }
  }

  const memText = reader("/proc/meminfo");
  if (memText !== null) {
    const mem = parseProcMeminfo(memText);
    if (mem) {
      const used = (mem.memTotalKb - mem.memAvailableKb) / mem.memTotalKb;
      features.memUsedRatio = used;
      events.push(occupancyEvent("mem_used_ratio", used, at));
    }
  }

  const statText = reader("/proc/stat");
  let cpu: CpuStat | null = null;
  if (statText !== null) {
    cpu = parseProcStatCpu(statText);
    if (cpu && prevCpu) {
      const busy = cpuBusyRatio(prevCpu, cpu);
      if (busy !== null) {
        features.cpuBusy = busy;
        events.push(occupancyEvent("cpu_busy", busy, at));
      }
    }
  }

  return { features, events, cpu };
}

function occupancyEvent(metric: string, value: number, at: string): StatsEvent {
  return {
    source: "os_occupancy",
    metric,
    value,
    at,
  };
}
