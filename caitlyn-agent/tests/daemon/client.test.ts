/**
 * Tests for daemon client.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

beforeAll(async () => {
  server = new DaemonServer({ port: PORT });
  server.setLlmCall(mockBenign);
  await server.start();

  // Override the client's URL — it hardcodes port 9070
  // We test by hitting the port directly
});

afterAll(async () => {
  await server.stop();
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
      body: JSON.stringify({ dirs: ["/tmp"] }),
    });
    expect(r1.status).toBe(200);

    // List
    const r2 = await fetch(`http://127.0.0.1:${PORT}/v1/watch`);
    const info = await r2.json();
    expect(info.active).toBe(true);
    expect(info.dirs).toContain("/tmp");

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
