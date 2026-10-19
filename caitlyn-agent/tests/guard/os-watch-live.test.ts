/**
 * Live tests on this machine: real /proc values, and a spawned
 * daemon-entry process that stays resident with bounded RSS.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DaemonServer } from "../../src/daemon/server.js";
import { parseProcLoadavg } from "../../src/guard/os-occupancy.js";
import { parseSockstatInuse } from "../../src/evolution/network-probe.js";

const LIVE = fs.existsSync("/proc/loadavg");
const AGENT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PORT = 19183;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readVmRssKb(pid: number): number | null {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
    const line = text.split("\n").find((l) => l.startsWith("VmRSS:"));
    if (!line) return null;
    const kb = Number(line.replace(/[^0-9]/g, ""));
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

describe.skipIf(!LIVE)("live OS watcher on this machine", () => {
  it("matches /proc/loadavg and tcp socket counts on a live tick", async () => {
    const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-oslive-"));
    const server = new DaemonServer({
      port: 19182,
      statsDir,
      occupancyPollMs: 60_000,
      componentPollMs: 60_000,
      componentRoots: [],
    });
    await server.start();
    try {
      const res = await fetch("http://127.0.0.1:19182/v1/os-watch");
      const body = await res.json();
      const load = parseProcLoadavg(fs.readFileSync("/proc/loadavg", "utf-8"));
      expect(load).not.toBeNull();
      expect(body.os.features.load1).toBeCloseTo(load!.load1, 1);
      expect(Math.abs(body.os.features.processes - load!.processes)).toBeLessThan(32);
      expect(body.tickUs).toBeLessThan(80_000);
      expect(body.os.tickUs).toBeLessThan(20_000);
      expect(body.events).toBeUndefined();

      const tcpInuse = parseSockstatInuse(
        fs.readFileSync("/proc/net/sockstat", "utf-8"),
        "TCP",
      );
      expect(tcpInuse).not.toBeNull();
      expect(Math.abs((body.os.features.tcpSockets ?? 0) - tcpInuse!)).toBeLessThan(16);
    } finally {
      await server.stop();
    }
  });
});

describe.skipIf(!LIVE)("spawned resident daemon-entry on this machine", () => {
  const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-daemon-live-"));
  const pidFile = path.join(statsDir, "daemon.pid");
  let child: ChildProcess | null = null;

  afterAll(async () => {
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await sleep(200);
    }
  });

  it("stays alive, serves os-watch, and stays under 400 MiB RSS", async () => {
    const tsxCli = path.join(AGENT_ROOT, "node_modules/tsx/dist/cli.mjs");
    expect(fs.existsSync(tsxCli)).toBe(true);
    const entry = path.join(AGENT_ROOT, "src/daemon-entry.ts");

    child = spawn(
      process.execPath,
      [tsxCli, entry, "--port", String(PORT)],
      {
        cwd: AGENT_ROOT,
        env: {
          ...process.env,
          CAITLYN_PID_FILE: pidFile,
          CAITLYN_STATS_DIR: statsDir,
          CAITLYN_DISABLE_EVOLUTION: "1",
          CAITLYN_OCCUPANCY_POLL_MS: "200",
          CAITLYN_COMPONENT_POLL_MS: "5000",
          CAITLYN_COMPONENT_ROOTS: "",
        },
        stdio: "ignore",
      },
    );

    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 8000) {
      try {
        const health = await fetch(`http://127.0.0.1:${PORT}/v1/health`, {
          signal: AbortSignal.timeout(400),
        });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        /* not listening yet */
      }
      await sleep(100);
    }
    expect(ready).toBe(true);
    expect(child.pid).toBeGreaterThan(0);
    expect(readVmRssKb(child.pid!)).not.toBeNull();

    const first = await fetch(`http://127.0.0.1:${PORT}/v1/os-watch`);
    expect(first.ok).toBe(true);
    const snap = await first.json();
    expect(typeof snap.os.features.load1).toBe("number");
    expect(snap.tickUs).toBeLessThan(80_000);
    const load = parseProcLoadavg(fs.readFileSync("/proc/loadavg", "utf-8"));
    expect(snap.os.features.load1).toBeCloseTo(load!.load1, 1);

    const pid = child.pid!;
    expect(() => process.kill(pid, 0)).not.toThrow();
    const rssKb = readVmRssKb(pid);
    expect(rssKb).toBeGreaterThan(1000);
    expect(rssKb).toBeLessThan(400 * 1024);

    const pollsBefore = (await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json())
      .host_watch_polls as number;
    await sleep(500);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const pollsAfter = (await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json())
      .host_watch_polls as number;
    expect(pollsAfter).toBeGreaterThan(pollsBefore);
  }, 15_000);
});
