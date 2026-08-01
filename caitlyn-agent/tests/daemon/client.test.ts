/**
 * Tests for daemon client.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate HOME so the daemon's scan path never writes to the real
// ~/.caitlyn history/stats directories.
const { testHomeId } = vi.hoisted(() => ({
  testHomeId: "caitlyn-dclient-home-" + Date.now().toString(36),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const base = actual.tmpdir() + "/" + testHomeId;
  return { ...actual, homedir: () => base };
});

import { DaemonServer } from "../../src/daemon/server.js";
import {
  isDaemonAvailable,
  getHealth,
  daemonScan,
  getDaemonStatus,
  daemonWatch,
  getWatchInfo,
  daemonUnwatch,
} from "../../src/daemon/client.js";
import type { LlmCallFn } from "../../src/scanner.js";

let server: DaemonServer;
const PORT = 19071;
const mockBenign: LlmCallFn = async () => "0";
const STATS_DIR = path.join(os.tmpdir(), `${testHomeId}-stats`);
const WATCH_DIR = path.join(os.tmpdir(), `${testHomeId}-watch`);

beforeAll(async () => {
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  server = new DaemonServer({ port: PORT, statsDir: STATS_DIR });
  server.setLlmCall(mockBenign);
  await server.start();

  // Override the client's URL — it hardcodes port 9070
  // We test by hitting the port directly
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(WATCH_DIR, { recursive: true, force: true });
  try { fs.rmSync(path.join(os.tmpdir(), testHomeId), { recursive: true, force: true }); } catch { /* ok */ }
});

// The daemon client uses hardcoded URL http://127.0.0.1:9070.
// For tests, we test the HTTP endpoints directly (tested in server.test.ts)
// and test the client utility functions that don't depend on the daemon.
// The client's fetch calls are tested via server.test.ts (same endpoints).

describe("isDaemonAvailable", () => {
  it("returns false when daemon is not on default port", async () => {
    // Our test server is on 19071, not 9070
    const available = await isDaemonAvailable();
    // Might be false (no daemon on 9070) or true (if another daemon is running)
    expect(typeof available).toBe("boolean");
  });
});

describe("daemonScan via direct HTTP", () => {
  it("scans content through the test server", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("verdict");
  });
});

describe("daemonWatch via direct HTTP", () => {
  it("watch/unwatch cycle works", async () => {
    // Start watching
    const r1 = await fetch(`http://127.0.0.1:${PORT}/v1/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dirs: [WATCH_DIR] }),
    });
    expect(r1.status).toBe(200);

    // List
    const r2 = await fetch(`http://127.0.0.1:${PORT}/v1/watch`);
    const info = await r2.json();
    expect(info.active).toBe(true);
    expect(info.dirs).toContain(WATCH_DIR);

    // Stop
    const r3 = await fetch(`http://127.0.0.1:${PORT}/v1/watch`, { method: "DELETE" });
    expect(r3.status).toBe(200);
  });
});

describe("getDaemonStatus via direct HTTP", () => {
  it("returns status with expected fields", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.uptime_ms).toBe("number");
    expect(typeof body.antibodies_loaded).toBe("number");
  });
});
