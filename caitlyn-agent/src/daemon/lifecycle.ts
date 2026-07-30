/**
 * CAITLYN Daemon — Lifecycle Management
 *
 * Start, stop, and check status of the background daemon process.
 * Uses a PID file to track the running instance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

// ── Constants ───────────────────────────────────────────────────────

const PID_FILE = path.join(os.tmpdir(), "caitlyn-daemon.pid");
const DEFAULT_PORT = 9070;
const STARTUP_TIMEOUT_MS = 5000;

// ── Public API ──────────────────────────────────────────────────────

/** Check if the daemon is running. */
export function isDaemonRunning(): boolean {
  try {
    const pid = readPid();
    if (!pid) return false;
    // Signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get the daemon's PID, or null if not running. */
export function getDaemonPid(): number | null {
  try {
    const pid = readPid();
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Start the daemon in the background.
 * Returns true if started, false if already running.
 */
export async function startDaemon(port: number = DEFAULT_PORT): Promise<{ started: boolean; message: string }> {
  if (isDaemonRunning()) {
    const pid = getDaemonPid();
    return { started: false, message: `Daemon already running (PID ${pid})` };
  }

  // Find the daemon entry script
  const entryPath = findEntryScript();
  if (!entryPath) {
    return { started: false, message: "Cannot find daemon entry script" };
  }

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [entryPath, "--port", String(port)],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CAITLYN_DAEMON: "1" },
      },
    );

    child.unref();

    // Wait for daemon to be ready (health check)
    const start = Date.now();
    const check = setInterval(() => {
      if (isDaemonRunning()) {
        clearInterval(check);
        resolve({ started: true, message: `Daemon started on port ${port}` });
      } else if (Date.now() - start > STARTUP_TIMEOUT_MS) {
        clearInterval(check);
        resolve({ started: false, message: "Daemon startup timed out" });
      }
    }, 200);
  });
}

/** Stop the daemon. */
export function stopDaemon(): { stopped: boolean; message: string } {
  const pid = getDaemonPid();
  if (!pid) {
    return { stopped: false, message: "Daemon is not running" };
  }

  try {
    process.kill(pid, "SIGTERM");
    // Remove PID file
    try { fs.unlinkSync(PID_FILE); } catch { /* ok */ }
    return { stopped: true, message: `Daemon stopped (PID ${pid})` };
  } catch (err) {
    return { stopped: false, message: `Failed to stop daemon: ${String(err)}` };
  }
}

/** Get daemon status for display. */
export function daemonStatus(): {
  running: boolean;
  pid: number | null;
  port: number;
} {
  return {
    running: isDaemonRunning(),
    pid: getDaemonPid(),
    port: DEFAULT_PORT,
  };
}

// ── PID File ────────────────────────────────────────────────────────

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Write the current process PID to the PID file. Called by the daemon on startup. */
export function writePidFile(): void {
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

/** Remove the PID file. Called by the daemon on shutdown. */
export function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ok */ }
}

// ── Helpers ─────────────────────────────────────────────────────────

function findEntryScript(): string | null {
  // When running from dist/
  const candidates = [
    path.join(import.meta.dirname, "..", "daemon-entry.js"),
    path.join(import.meta.dirname, "..", "..", "src", "daemon", "entry.ts"),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch { /* try next */ }
  }
  return null;
}
