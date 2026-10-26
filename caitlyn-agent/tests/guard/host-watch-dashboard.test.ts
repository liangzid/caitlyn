/**
 * Host-watch dashboard formatter and incident jsonl reader.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  energyBar,
  formatHostWatchDashboard,
  renderHostWatchLiveLines,
  sparkline,
} from "../../src/components/host-watch-dashboard.js";
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
      },
      null,
      80,
    ).join("\n");
    expect(lines).toContain("OCCUPANCY");
    expect(lines).toContain("tcp4 30");
    expect(lines).toContain("WATCHING");
    expect(lines).toContain("1 channels");
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
