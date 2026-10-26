/**
 * CAITLYN Guard — Host process inventory
 *
 * Reads /proc/<pid>/stat for thread-group rows. Detect-only: never
 * sends signals. Kernel workers with empty useful comm still appear
 * if they rank in RSS/CPU.
 *
 * KEYPOINT FOR 团长 REVIEW: this is a ranked table, not a kill UI.
 * 18k /proc entries on this class of host are scanned; the dashboard
 * only renders the top slice plus agent-tagged rows.
 */

import * as fs from "node:fs";
import { parseProcLoadavg, parseProcMeminfo, type LoadavgStat, type MeminfoStat } from "./os-occupancy.js";

const CLK_TCK = 100;
const PAGE_KB = 4;
const AGENT_MARK =
  /caitlyn|claude|cursor|codex|opencode|hermes|anthropic|openclaw|tetragon|mop/i;

export type ProcSortKey = "cpu" | "rss";

export interface ProcStatRow {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  threads: number;
  utime: number;
  stime: number;
  rssKb: number;
}

export interface HostProcessRow {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  threads: number;
  rssKb: number;
  cpuPct: number | null;
  agent: boolean;
  cmdline: string;
}

export type AgentWatchStatus = "safe" | "daemon" | "graft" | "warming";

export interface HostProcessInventory {
  load: LoadavgStat | null;
  mem: MeminfoStat | null;
  uptimeSec: number | null;
  openFiles: number | null;
  fileMax: number | null;
  procDirs: number;
  leaders: number;
  rows: HostProcessRow[];
  scanMs: number;
}

export interface ProcCpuPrev {
  atMs: number;
  jiffies: Map<number, number>;
}

/**
 * Parse one `/proc/<pid>/stat` line. comm may contain spaces and `)`.
 */
export function parseProcPidStat(text: string): ProcStatRow | null {
  const lpar = text.indexOf("(");
  const rpar = text.lastIndexOf(")");
  if (lpar < 0 || rpar < lpar) return null;
  const pid = Number(text.slice(0, lpar).trim());
  const comm = text.slice(lpar + 1, rpar);
  const rest = text.slice(rpar + 2).trim().split(/\s+/);
  if (!Number.isFinite(pid) || rest.length < 22) return null;
  const state = rest[0] ?? "?";
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const threads = Number(rest[17]);
  const rssPages = Number(rest[21]);
  if (![ppid, utime, stime, threads, rssPages].every(Number.isFinite)) return null;
  return { pid, comm, state, ppid, threads, utime, stime, rssKb: rssPages * PAGE_KB };
}

export function isAgentTaggedProcess(text: string): boolean {
  return AGENT_MARK.test(text);
}

/** Cmdline is NUL-separated in procfs. */
export function parseProcCmdline(text: string): string {
  return text.replace(/\0/g, " ").trim();
}

/**
 * SAFE means Caitlyn is watching this agent runtime and the ACE channel
 * is quiet. It is not a malware verdict.
 */
export function agentWatchStatus(
  row: HostProcessRow,
  opts: { daemonPid: number | null; aceDetect: boolean; calibrated: boolean },
): AgentWatchStatus {
  if (opts.daemonPid != null && row.pid === opts.daemonPid) return "daemon";
  if (opts.aceDetect) return "graft";
  if (!opts.calibrated) return "warming";
  return "safe";
}

function readText(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function parseUptime(text: string): number | null {
  const first = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(first) ? first : null;
}

function parseFileNr(text: string): { open: number; max: number } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const open = Number(parts[0]);
  const max = Number(parts[2]);
  if (![open, max].every(Number.isFinite)) return null;
  return { open, max };
}

function listProcPids(): string[] {
  try {
    return fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
}

function readAllProcStats(): ProcStatRow[] {
  const rows: ProcStatRow[] = [];
  for (const name of listProcPids()) {
    const text = readText(`/proc/${name}/stat`);
    if (text === null) continue;
    const parsed = parseProcPidStat(text);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function cpuPct(
  pid: number,
  jiffies: number,
  elapsedSec: number,
  prev: ProcCpuPrev | null,
): number | null {
  if (!prev || elapsedSec <= 0) return null;
  const before = prev.jiffies.get(pid);
  if (before === undefined) return null;
  const dj = jiffies - before;
  if (dj < 0) return null;
  return (100 * dj) / CLK_TCK / elapsedSec;
}

function rankRows(
  stats: ProcStatRow[],
  prev: ProcCpuPrev | null,
  elapsedSec: number,
  sort: ProcSortKey,
  limit: number,
): HostProcessRow[] {
  const mapped: HostProcessRow[] = stats.map((row) => ({
    pid: row.pid,
    comm: row.comm,
    state: row.state,
    ppid: row.ppid,
    threads: row.threads,
    rssKb: row.rssKb,
    cpuPct: cpuPct(row.pid, row.utime + row.stime, elapsedSec, prev),
    agent: isAgentTaggedProcess(row.comm),
    cmdline: "",
  }));
  mapped.sort((a, b) => {
    if (sort === "rss") return b.rssKb - a.rssKb;
    const ac = a.cpuPct ?? -1;
    const bc = b.cpuPct ?? -1;
    if (bc !== ac) return bc - ac;
    return b.rssKb - a.rssKb;
  });
  const top = mapped.slice(0, limit);
  const have = new Set(top.map((r) => r.pid));
  for (const row of mapped) {
    if (!row.agent || have.has(row.pid)) continue;
    top.push(row);
    have.add(row.pid);
    if (top.length >= limit + 8) break;
  }
  return attachCmdlines(top);
}

function attachCmdlines(rows: HostProcessRow[]): HostProcessRow[] {
  return rows.map((row) => {
    const raw = readText(`/proc/${row.pid}/cmdline`);
    const cmdline = raw ? parseProcCmdline(raw) : "";
    return {
      ...row,
      cmdline,
      agent: row.agent || isAgentTaggedProcess(cmdline),
    };
  });
}

/**
 * One inventory pass: load/mem/uptime plus ranked processes.
 * `prev` supplies CPU deltas; pass the returned prev into the next call.
 */
export function collectHostProcessInventory(
  prev: ProcCpuPrev | null = null,
  sort: ProcSortKey = "cpu",
  limit: number = 64,
): { inventory: HostProcessInventory; prev: ProcCpuPrev } {
  const t0 = Date.now();
  const stats = readAllProcStats();
  const now = Date.now();
  const elapsedSec = prev ? Math.max(0.05, (now - prev.atMs) / 1000) : 0;
  const loadText = readText("/proc/loadavg");
  const memText = readText("/proc/meminfo");
  const upText = readText("/proc/uptime");
  const fileText = readText("/proc/sys/fs/file-nr");
  const files = fileText ? parseFileNr(fileText) : null;
  const inventory: HostProcessInventory = {
    load: loadText ? parseProcLoadavg(loadText) : null,
    mem: memText ? parseProcMeminfo(memText) : null,
    uptimeSec: upText ? parseUptime(upText) : null,
    openFiles: files?.open ?? null,
    fileMax: files?.max ?? null,
    procDirs: stats.length,
    leaders: stats.length,
    rows: rankRows(stats, prev, elapsedSec, sort, limit),
    scanMs: Date.now() - t0,
  };
  const jiffies = new Map<number, number>();
  for (const row of stats) jiffies.set(row.pid, row.utime + row.stime);
  return { inventory, prev: { atMs: now, jiffies } };
}
