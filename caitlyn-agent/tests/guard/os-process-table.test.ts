/**
 * Process-table parsers and a live /proc inventory on this host.
 */
import { describe, expect, it } from "vitest";
import {
  agentWatchStatus,
  collectHostProcessInventory,
  isAgentTaggedProcess,
  parseProcPidStat,
} from "../../src/guard/os-process-table.js";

const SAMPLE_STAT =
  "1061356 (python3) R 1061336 1061336 1061336 0 -1 4194304 1365 0 0 0 1 1 0 0 20 0 1 0 2452878329 20803584 2304 18446744073709551615 4325376 7566882 140732378073472 0 0 0 0 16781312 2 0 0 0 17 186 0 0 0 0 0 9408976 9936208 313430016 140732378076496 140732378076506 140732378076506 140732378079193 0";

describe("parseProcPidStat", () => {
  it("reads pid, comm, state, jiffies, and rss pages from a recorded stat line", () => {
    const row = parseProcPidStat(SAMPLE_STAT);
    expect(row).not.toBeNull();
    expect(row?.pid).toBe(1061356);
    expect(row?.comm).toBe("python3");
    expect(row?.state).toBe("R");
    expect(row?.ppid).toBe(1061336);
    expect(row?.threads).toBe(1);
    expect(row?.utime).toBe(1);
    expect(row?.stime).toBe(1);
    expect(row?.rssKb).toBe(2304 * 4);
  });
});

describe("isAgentTaggedProcess", () => {
  it("tags caitlyn and cursor comms only", () => {
    expect(isAgentTaggedProcess("caitlyn")).toBe(true);
    expect(isAgentTaggedProcess("node-MainThread")).toBe(false);
  });
});

describe("agentWatchStatus", () => {
  it("marks the daemon and quiet tagged agents as SAFE", () => {
    const row = {
      pid: 9,
      comm: "caitlyn",
      state: "S",
      ppid: 1,
      threads: 1,
      rssKb: 1000,
      cpuPct: 0,
      agent: true,
      cmdline: "caitlyn dashboard",
    };
    expect(agentWatchStatus(row, { daemonPid: 9, aceDetect: false, calibrated: true })).toBe("daemon");
    expect(agentWatchStatus({ ...row, pid: 10 }, { daemonPid: 9, aceDetect: false, calibrated: true })).toBe("safe");
    expect(agentWatchStatus({ ...row, pid: 10 }, { daemonPid: 9, aceDetect: true, calibrated: true })).toBe("graft");
  });
});

describe("collectHostProcessInventory", () => {
  it("reads this machine's /proc and returns ranked rows", () => {
    const first = collectHostProcessInventory(null, "rss", 20);
    expect(first.inventory.procDirs).toBeGreaterThan(10);
    expect(first.inventory.rows.length).toBeGreaterThan(0);
    expect(first.inventory.rows[0]?.rssKb).toBeGreaterThan(0);
    expect(first.inventory.scanMs).toBeGreaterThanOrEqual(0);
    const second = collectHostProcessInventory(first.prev, "cpu", 20);
    expect(second.inventory.rows.some((r) => r.cpuPct != null)).toBe(true);
  });
});
