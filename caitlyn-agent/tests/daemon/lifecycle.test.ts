/**
 * Tests for daemon lifecycle management.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isDaemonRunning,
  getDaemonPid,
  daemonStatus,
  writePidFile,
  removePidFile,
} from "../../src/daemon/lifecycle.js";

// ── PID File Helpers ────────────────────────────────────────────────

const PID_FILE = path.join(os.tmpdir(), "caitlyn-daemon.pid");

function cleanPidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ok */ }
}

afterEach(cleanPidFile);

// ── PID File Operations ─────────────────────────────────────────────

describe("PID file operations", () => {
  it("writePidFile creates a valid PID file", () => {
    cleanPidFile();
    writePidFile();
    expect(fs.existsSync(PID_FILE)).toBe(true);
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    expect(parseInt(raw, 10)).toBe(process.pid);
  });

  it("removePidFile deletes the PID file", () => {
    writePidFile();
    removePidFile();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("removePidFile is safe when no file exists", () => {
    cleanPidFile();
    expect(() => removePidFile()).not.toThrow();
  });
});

// ── Status Checks ───────────────────────────────────────────────────

describe("daemon status checks", () => {
  it("isDaemonRunning returns false when no PID file", () => {
    cleanPidFile();
    expect(isDaemonRunning()).toBe(false);
  });

  it("isDaemonRunning returns true when own PID is written", () => {
    writePidFile();
    expect(isDaemonRunning()).toBe(true);
  });

  it("isDaemonRunning returns false for nonexistent PID", () => {
    // Write a PID that doesn't exist (99999 is unlikely to be alive)
    fs.writeFileSync(PID_FILE, "99999", "utf-8");
    expect(isDaemonRunning()).toBe(false);
  });

  it("getDaemonPid returns the PID when running", () => {
    writePidFile();
    expect(getDaemonPid()).toBe(process.pid);
  });

  it("getDaemonPid returns null when not running", () => {
    cleanPidFile();
    expect(getDaemonPid()).toBeNull();
  });

  it("daemonStatus returns correct structure", () => {
    writePidFile();
    const status = daemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(9070);
  });

  it("daemonStatus returns not-running when no PID file", () => {
    cleanPidFile();
    const status = daemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});

// ── Invalid PID File ────────────────────────────────────────────────

describe("invalid PID file handling", () => {
  it("handles garbage in PID file", () => {
    fs.writeFileSync(PID_FILE, "not-a-number", "utf-8");
    expect(isDaemonRunning()).toBe(false);
    expect(getDaemonPid()).toBeNull();
  });

  it("handles empty PID file", () => {
    fs.writeFileSync(PID_FILE, "", "utf-8");
    expect(isDaemonRunning()).toBe(false);
    expect(getDaemonPid()).toBeNull();
  });
});
