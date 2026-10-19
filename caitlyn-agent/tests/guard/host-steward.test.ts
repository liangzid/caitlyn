/**
 * Tests for ACE watcher ticks and host-steward channel fusion.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AceWatcher } from "../../src/guard/ace-watcher.js";
import { fuseHostChannels, HostSteward } from "../../src/guard/host-steward.js";
import { OsWatcher } from "../../src/guard/os-watcher.js";
import type { OsWatchTick } from "../../src/guard/os-watcher.js";
import type { AceWatchTick } from "../../src/guard/ace-watcher.js";

const quietOs: OsWatchTick = {
  at: "2026-10-19T00:00:00.000Z",
  features: {},
  energy: 0,
  channels: { occupancy: 0, network: 0 },
  intervention: "none",
  events: [],
  calibrated: true,
  tickUs: 0,
};

function aceTick(over: Partial<AceWatchTick>): AceWatchTick {
  return {
    at: "2026-10-19T00:00:00.000Z",
    energy: 0,
    nodeCount: 0,
    mutationCount: 0,
    intervention: "none",
    calibrated: true,
    events: [],
    diff: { added: [], removed: [], changed: [], energy: 0 },
    roots: [],
    quarantined: [],
    tickUs: 0,
    ...over,
  };
}

describe("fuseHostChannels", () => {
  it("fires on component graft with quiet occupancy", () => {
    const fused = fuseHostChannels(
      quietOs,
      aceTick({ energy: 2, intervention: "detect" }),
      3,
      3,
    );
    expect(fused.intervention).toBe("detect");
    expect(fused.hotChannels).toEqual(["component"]);
  });

  it("fires on occupancy without component mutations", () => {
    const fused = fuseHostChannels(
      { ...quietOs, channels: { occupancy: 4, network: 0 } },
      aceTick({}),
      3,
      3,
    );
    expect(fused.hotChannels).toEqual(["occupancy"]);
  });
});

describe("AceWatcher and HostSteward", () => {
  it("detects a grafted skill after the baseline tick and records an incident", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-steward-"));
    fs.mkdirSync(path.join(root, "skills", "benign"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "benign", "SKILL.md"), "name: benign\n");
    const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-steward-stats-"));

    const proc = {
      "/proc/loadavg": "0.10 0.10 0.10 1/100 1\n",
      "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 500 kB\n",
      "/proc/stat": "cpu  10 0 10 80 0 0 0 0 0 0\n",
      "/proc/net/tcp": "  sl  local_address rem_address   st\n",
    };
    const reader = (p: string) => proc[p as keyof typeof proc] ?? null;

    const steward = new HostSteward({
      statsDir,
      osWatcher: new OsWatcher({ reader, minSamples: 99, energyThreshold: 99 }),
      aceWatcher: new AceWatcher({ roots: [root] }),
    });

    const baseline = steward.tick();
    expect(baseline.ace.calibrated).toBe(false);
    expect(baseline.intervention).toBe("none");

    fs.mkdirSync(path.join(root, "skills", "grafted"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "grafted", "SKILL.md"), "name: grafted\n");
    const hot = steward.tick();
    expect(hot.hotChannels).toContain("component");
    expect(hot.intervention).toBe("detect");
    expect(hot.channels.component).toBeGreaterThanOrEqual(1);

    const incidents = fs.readFileSync(path.join(statsDir, "host-incidents.jsonl"), "utf-8");
    expect(incidents).toContain("component");
  });

  it("occupancy-only ticks do not pick up a new skill graft", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-ace-defer-"));
    fs.mkdirSync(path.join(root, "skills", "benign"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "benign", "SKILL.md"), "name: benign\n");
    const steward = new HostSteward({
      osWatcher: new OsWatcher({
        reader: () => null,
        minSamples: 99,
        energyThreshold: 99,
      }),
      aceWatcher: new AceWatcher({ roots: [root] }),
    });
    expect(steward.tick(new Date(), true).intervention).toBe("none");
    fs.mkdirSync(path.join(root, "skills", "grafted"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "grafted", "SKILL.md"), "name: grafted\n");
    const occupancyOnly = steward.tick(new Date(), false);
    expect(occupancyOnly.hotChannels).not.toContain("component");
    const withAce = steward.tick(new Date(), true);
    expect(withAce.hotChannels).toContain("component");
  });

  it("quarantines an added skill and leaves config in place", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-ace-q-"));
    const qdir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-ace-qdir-"));
    fs.mkdirSync(path.join(root, "skills", "benign"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "benign", "SKILL.md"), "name: benign\n");
    fs.writeFileSync(path.join(root, "settings.json"), "{}\n");
    const watcher = new AceWatcher({ roots: [root], quarantineDir: qdir });
    expect(watcher.tick().intervention).toBe("none");
    fs.mkdirSync(path.join(root, "skills", "grafted"), { recursive: true });
    const graft = path.join(root, "skills", "grafted", "SKILL.md");
    fs.writeFileSync(graft, "name: grafted\n");
    fs.writeFileSync(path.join(root, "settings.json"), '{"ok":true}\n');
    const hot = watcher.tick();
    expect(hot.intervention).toBe("detect");
    expect(hot.quarantined.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(graft)).toBe(false);
    expect(fs.existsSync(path.join(root, "settings.json"))).toBe(true);
    expect(fs.readdirSync(qdir).some((n) => n.includes("SKILL.md"))).toBe(true);
  });
});
