/**
 * CAITLYN Daemon — HTTP Server
 *
 * Background process hosting the scanner and FS Watcher.
 * CLI/TUI communicate with it via HTTP on localhost:9070.
 *
 * Endpoints:
 *   GET  /v1/health          — health check
 *   POST /v1/scan            — scan content (Tier 0 + Tier 1)
 *   POST /v1/watch           — start watching a directory
 *   GET  /v1/watch           — list watched dirs + stats
 *   DELETE /v1/watch          — stop watching all dirs
 *   GET  /v1/status           — daemon status
 */

import * as http from "node:http";
import { hybridScan } from "../hybrid-scanner.js";
import { loadAntibodies, loadAntigens } from "../library.js";
import { FSWatcher } from "../guard/fs-watcher.js";
import { createUnavailableLlmCall, type LlmCallFn } from "../scanner.js";
import type { ScanResult } from "../schema.js";

// ── Types ───────────────────────────────────────────────────────────

export interface DaemonConfig {
  port: number;
  host: string;
}

export interface DaemonStatus {
  pid: number;
  uptime_ms: number;
  antibodies_loaded: number;
  antigens_loaded: number;
  scans_total: number;
  scans_blocked: number;
  scans_flagged: number;
  scans_allowed: number;
  watch_dirs: string[];
  watch_stats: {
    totalEvents: number;
    filesScanned: number;
    filesBlocked: number;
    filesFlagged: number;
    filesAllowed: number;
  } | null;
}

// ── Daemon Server ───────────────────────────────────────────────────

export class DaemonServer {
  private server: http.Server | null = null;
  private config: DaemonConfig;
  private startTime: number = 0;
  private llmCall: LlmCallFn | null = null;

  // Stats
  private scansTotal = 0;
  private scansBlocked = 0;
  private scansFlagged = 0;
  private scansAllowed = 0;

  // FS Watcher
  private watcher: FSWatcher | null = null;
  private watchDirs: string[] = [];

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = { port: 9070, host: "127.0.0.1", ...config };
  }

  setLlmCall(fn: LlmCallFn): void {
    this.llmCall = fn;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server.on("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.watcher) {
        this.watcher.stop().catch(() => {});
        this.watcher = null;
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return this.config.port;
  }

  // ── Request Handler ────────────────────────────────────────────

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${this.config.host}`);
    const path = url.pathname;
    const method = req.method || "GET";

    // CORS for localhost
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === "/v1/health" && method === "GET") {
        await this._health(res);
      } else if (path === "/v1/scan" && method === "POST") {
        await this._scan(req, res);
      } else if (path === "/v1/watch" && method === "POST") {
        await this._watchStart(req, res);
      } else if (path === "/v1/watch" && method === "GET") {
        await this._watchList(res);
      } else if (path === "/v1/watch" && method === "DELETE") {
        await this._watchStop(res);
      } else if (path === "/v1/status" && method === "GET") {
        await this._status(res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  // ── Endpoints ──────────────────────────────────────────────────

  private async _health(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime_ms: Date.now() - this.startTime }));
  }

  private async _scan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { content?: string } = {};
    try { parsed = JSON.parse(body); } catch { /* invalid JSON handled below */ }

    if (!parsed.content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing 'content' field" }));
      return;
    }

    const content = parsed.content.slice(0, 65536); // 64KB max

    let result: ScanResult;
    // Without an LLM, run Tier 0 scripts only (they never need the LLM) and
    // let the scan pipeline mark the degraded mode in its failure path.
    result = await hybridScan({
      content,
      llmCall: this.llmCall ?? createUnavailableLlmCall("LLM not configured on daemon"),
    });

    // Update stats
    this.scansTotal++;
    if (result.verdict === "malicious") this.scansBlocked++;
    else if (result.verdict === "suspicious") this.scansFlagged++;
    else this.scansAllowed++;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async _watchStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { dirs?: string[] } = {};
    try { parsed = JSON.parse(body); } catch { /* handled below */ }

    if (!parsed.dirs || parsed.dirs.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing 'dirs' field" }));
      return;
    }

    if (!this.watcher) {
      this.watcher = new FSWatcher(
        { watchDirs: parsed.dirs, quarantineDir: "/tmp/caitlyn-quarantine" },
        this.llmCall,
      );
      this.watcher.start();
    } else {
      // FSWatcher doesn't support adding dirs after start — recreate
      // (in a real implementation, we'd add this capability)
    }

    this.watchDirs = parsed.dirs;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, watching: this.watchDirs }));
  }

  private async _watchList(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        dirs: this.watchDirs,
        active: this.watcher !== null,
        stats: this.watcher?.getStats() ?? null,
      }),
    );
  }

  private async _watchStop(res: http.ServerResponse): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    this.watchDirs = [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  private async _status(res: http.ServerResponse): Promise<void> {
    const antibodies = loadAntibodies();
    const antigens = loadAntigens();

    const status: DaemonStatus = {
      pid: process.pid,
      uptime_ms: Date.now() - this.startTime,
      antibodies_loaded: antibodies.length,
      antigens_loaded: antigens.length,
      scans_total: this.scansTotal,
      scans_blocked: this.scansBlocked,
      scans_flagged: this.scansFlagged,
      scans_allowed: this.scansAllowed,
      watch_dirs: this.watchDirs,
      watch_stats: this.watcher?.getStats() ?? null,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
