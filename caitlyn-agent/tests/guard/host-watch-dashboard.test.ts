/**
 * Host-watch dashboard formatter and incident jsonl reader.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  energyBar,
  fitDashboardLine,
  formatHostWatchDashboard,
  renderHostWatchLiveLines,
  sparkline,
  type HostWatchChrome,
} from "../../src/components/host-watch-dashboard.js";
import { collectHostProcessInventory } from "../../src/guard/os-process-table.js";
import {
  HOST_INCIDENTS_FILENAME,
  readRecentIncidents,
  type HostWatchDashboardView,
} from "../../src/guard/host-steward.js";

function sampleView(over: Partial<HostWatchDashboardView> = {}): HostWatchDashboardView {
  return {
    at: "2026-10-26T00:00:00.000Z",
    energy: 0.4,
    channels: { occupancy: 0.2, network: 0.1, component: 0 },
    hotChannels: [],
    intervention: "none",
    calibrated: true,
    tickUs: 12000,
    os: {
      features: { load1: 0.5, cpuBusy: 0.1, memUsedRatio: 0.4, processes: 200, tcpSockets: 30 },
      energy: 0.3,
      channels: { occupancy: 0.2, network: 0.1 },
      intervention: "none",
      calibrated: true,
      tickUs: 8000,
    },
    ace: {
      energy: 0,
      nodeCount: 12,
      mutationCount: 0,
      intervention: "none",
      calibrated: true,
      roots: ["/home/zi/.cursor"],
      quarantined: [],
      tickUs: 4000,
    },
    incidents: [],
    polls: 3,
    occupancyPollMs: 10000,
    componentPollMs: 60000,
    sockstat: { tcpInuse: 30, tcpTw: 4, udpInuse: 2 },
    ...over,
  };
}

describe("energyBar", () => {
  it("fills the bar at the channel threshold", () => {
    expect(energyBar(3, 3)).toBe(`[${"#".repeat(16)}]`);
    expect(energyBar(0, 3)).toBe(`[${"-".repeat(16)}]`);
  });
});

describe("formatHostWatchDashboard", () => {
  it("prints channels, occupancy, sockstat, ACE, and incidents", () => {
    const text = formatHostWatchDashboard(
      sampleView({
        hotChannels: ["occupancy"],
        intervention: "detect",
        incidents: [
          {
            at: "2026-10-26T00:01:00.000Z",
            intervention: "detect",
            hotChannels: ["occupancy"],
            channels: { occupancy: 4, network: 0.1, component: 0 },
          },
        ],
      }),
    ).join("\n");
    expect(text).toContain("CAITLYN HOST WATCH");
    expect(text).toContain("*occupancy");
    expect(text).toContain("hot: occupancy");
    expect(text).toContain("tcp4 30");
    expect(text).toContain("tcp_sockets=30");
    expect(text).toContain("nodes=12");
    expect(text).toContain("2026-10-26T00:01:00.000Z  occupancy");
    expect(text).not.toContain("undefined");
  });
});

describe("sparkline", () => {
  it("pads an empty series and scales a rising series", () => {
    expect(sparkline([], 8)).toContain("········");
    const rising = sparkline([0, 1, 2, 3], 4);
    expect(rising).toContain("▁");
    expect(rising).toContain("█");
  });
});

describe("renderHostWatchLiveLines", () => {
  it("draws a ranked process table when inventory is present", () => {
    const lines = renderHostWatchLiveLines(
      sampleView(),
      { occupancy: [0.1], network: [0], component: [0] },
      {
        tab: "channels",
        paused: false,
        refreshMs: 1000,
        samples: 1,
        daemonPid: 42,
        daemonRssKb: 4096,
        error: null,
        inventory: {
          load: { load1: 1, load5: 1, load15: 1, runnable: 2, processes: 100 },
          mem: { memTotalKb: 64 * 1024 * 1024, memAvailableKb: 32 * 1024 * 1024 },
          uptimeSec: 3600,
          openFiles: 100,
          fileMax: 1000,
          procDirs: 50,
          leaders: 50,
          rows: [
            { pid: 42, comm: "caitlyn", state: "S", ppid: 1, threads: 4, rssKb: 80 * 1024, cpuPct: 3.2, agent: true, cmdline: "caitlyn dashboard" },
            { pid: 7, comm: "sshd", state: "S", ppid: 1, threads: 1, rssKb: 4000, cpuPct: 0.1, agent: false, cmdline: "/usr/sbin/sshd" },
          ],
          scanMs: 12,
        },
        procSort: "rss",
        procScroll: 0,
        height: 48,
      },
      null,
      140,
    ).join("\n");
    expect(lines).toContain("caitlyn");
    expect(lines).toContain("sshd");
    expect(lines).toContain("AGENT");
    expect(lines).toContain("SAFE");
    expect(lines).toContain("caitlyn dashboard");
  });

  it("draws themed channel chrome and sockstat", () => {
    const lines = renderHostWatchLiveLines(
      sampleView(),
      { occupancy: [0.1, 0.2], network: [0, 0.1], component: [0, 0] },
      {
        tab: "channels",
        paused: false,
        refreshMs: 1000,
        samples: 2,
        daemonPid: 1,
        daemonRssKb: 4096,
        error: null,
        inventory: null,
        procSort: "cpu",
        procScroll: 0,
        height: 40,
      },
      null,
      80,
    ).join("\n");
    expect(lines).toContain("OCCUPANCY");
    expect(lines).toContain("tcp4 30");
    expect(lines).toContain("WATCHING");
    expect(lines).toContain("1 host");
    expect(lines).toContain("process inventory not ready");
  });

  it("keeps every live line within the TUI width, including 279", () => {
    const collected = collectHostProcessInventory(null, "rss", 40);
    const inventory = {
      ...collected.inventory,
      rows: collected.inventory.rows.map((row) => ({
        ...row,
        cmdline: `${row.cmdline} ${"x".repeat(400)}`,
      })),
    };
    const chrome: HostWatchChrome = {
      tab: "channels",
      paused: false,
      refreshMs: 1000,
      samples: 4,
      daemonPid: process.pid,
      daemonRssKb: 4096,
      error: null,
      inventory,
      procSort: "rss",
      procScroll: 0,
      height: 50,
    };
    for (const width of [40, 80, 100, 120, 200, 279, 300]) {
      const lines = renderHostWatchLiveLines(
        sampleView({
          ace: { ...sampleView().ace, roots: ["/home/zi/.cursor", "/very/long/".repeat(20)] },
        }),
        { occupancy: [0.1, 3, 1], network: [0, 2], component: [0, 0.4] },
        { ...chrome, height: 50 },
        null,
        width,
      );
      expect(lines.length).toBeGreaterThan(10);
      for (const line of lines) {
        expect(visibleWidth(line), `width=${width} line=${JSON.stringify(line.slice(0, 120))}`).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });
});

describe("fitDashboardLine", () => {
  it("truncates ANSI-colored overflow to the cap", () => {
    const raw = `${"\x1b[38;5;45m"}${"W".repeat(300)}${"\x1b[0m"}`;
    const fitted = fitDashboardLine(raw, 279);
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(279);
  });
});

describe("readRecentIncidents", () => {
  it("returns the last valid detect lines and skips junk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-inc-"));
    fs.writeFileSync(
      path.join(dir, HOST_INCIDENTS_FILENAME),
      [
        "not-json",
        JSON.stringify({
          at: "a",
          intervention: "detect",
          hotChannels: ["network"],
          channels: { occupancy: 0, network: 5, component: 0 },
        }),
        JSON.stringify({
          at: "b",
          intervention: "detect",
          hotChannels: ["component"],
          channels: { occupancy: 0, network: 0, component: 2 },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const incidents = readRecentIncidents(dir, 8);
    expect(incidents).toHaveLength(2);
    expect(incidents[1]?.hotChannels).toEqual(["component"]);
  });

  it("returns empty when the file is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-inc-missing-"));
    expect(readRecentIncidents(dir)).toEqual([]);
  });
});
