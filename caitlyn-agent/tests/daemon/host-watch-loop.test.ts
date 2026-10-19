/**
 * Tests for the resident host-watch loop: first poll on start, then
 * occupancy timers without waiting a minute.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonServer } from "../../src/daemon/server.js";

const PORT = 19074;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("resident host-watch loop", () => {
  let statsDir: string;
  let server: DaemonServer;

  beforeAll(async () => {
    statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-hostloop-"));
    server = new DaemonServer({
      port: PORT,
      statsDir,
      occupancyPollMs: 80,
      componentPollMs: 10_000,
      componentRoots: [],
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("takes a snapshot before start() resolves", async () => {
    expect(server.getHostWatchPolls()).toBeGreaterThanOrEqual(1);
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/os-watch`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.energy).toBe("number");
    expect(body.os).toBeTruthy();
    expect(body.ace).toBeTruthy();
  });

  it("keeps polling occupancy while the process stays up", async () => {
    const before = server.getHostWatchPolls();
    await sleep(220);
    expect(server.getHostWatchPolls()).toBeGreaterThan(before);
    const status = await fetch(`http://127.0.0.1:${PORT}/v1/status`);
    const body = await status.json();
    expect(body.host_watch_polls).toBeGreaterThan(before);
    expect(body.occupancy_poll_ms).toBe(80);
    expect(body.component_poll_ms).toBe(10_000);
  });
});
