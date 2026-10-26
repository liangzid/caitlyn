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
 *   GET  /v1/os-watch         — occupancy, network, and ACE energy snapshot
 */

import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { hybridScan } from "../hybrid-scanner.js";
import { loadDefenseSkills, loadAttacks } from "../library.js";
import { FSWatcher } from "../guard/fs-watcher.js";
import { AceWatcher } from "../guard/ace-watcher.js";
import {
  HostSteward,
  readRecentIncidents,
  toHostWatchDashboardView,
  toPublicHostSnapshot,
  type HostWatchDashboardView,
  type PublicHostWatchSnapshot,
} from "../guard/host-steward.js";
import { isOsTelemetrySource } from "../guard/os-watcher.js";
import { createUnavailableLlmCall, parseScanMode, type LlmCallFn } from "../scanner.js";
import type { ScanResult } from "../schema.js";
import { loadEvolutionConfig, type EvolutionConfig } from "../config.js";
import { EvolutionEngine } from "../evolution/engine.js";
import { appendTriggerRecord } from "../evolution/stats-events.js";
import {
  StatsCollector,
  type AnomalyTrigger,
} from "../evolution/stats-collector.js";

// ── Types ───────────────────────────────────────────────────────────

export interface DaemonConfig {
  port: number;
  host: string;
  /** 统计目录；缺省 ~/.caitlyn/stats。测试可注入。 */
  statsDir?: string;
  /** evolution 配置覆盖；缺省从 config.toml 读取。 */
  evolutionConfig?: EvolutionConfig;
  /** ACE component roots; unset uses installed agent dirs. */
  componentRoots?: string[];
  /** Cheap /proc occupancy+net poll. Default 10s. */
  occupancyPollMs?: number;
  /** Agent component-graph inventory poll. Default 60s. */
  componentPollMs?: number;
}

/** Occupancy /proc poll period. procfs reads are cheap; keep this modest. */
export const DEFAULT_OCCUPANCY_POLL_MS = 10_000;
/** ACE directory walk period. Heavier than /proc, so slower. */
export const DEFAULT_COMPONENT_POLL_MS = 60_000;

export interface DaemonStatus {
  pid: number;
  uptime_ms: number;
  defense_skills_loaded: number;
  attacks_loaded: number;
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
  os_watch: PublicHostWatchSnapshot | null;
  host_watch_polls: number;
  occupancy_poll_ms: number;
  component_poll_ms: number;
}

/** Maximum accepted request body (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;
/** Per-request timeout for the local HTTP server. */
const REQUEST_TIMEOUT_MS = 180_000;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
  }
}

// ── Daemon Server ───────────────────────────────────────────────────

export class DaemonServer {
  private server: http.Server | null = null;
  private config: DaemonConfig;
  private startTime: number = 0;
  private llmCall: LlmCallFn | null = null;
  private generatorLlm: LlmCallFn | null = null;
  private reviewerLlm: LlmCallFn | null = null;
  private statsCollector: StatsCollector;
  private evolutionConfig: EvolutionConfig;
  private occupancyTimer: NodeJS.Timeout | null = null;
  private componentTimer: NodeJS.Timeout | null = null;
  private collectInFlight = false;
  private evolutionDisabled: boolean;
  private hostWatchPolls = 0;
  private occupancyPollMs: number;
  private componentPollMs: number;

  // Stats
  private scansTotal = 0;
  private scansBlocked = 0;
  private scansFlagged = 0;
  private scansAllowed = 0;

  // FS Watcher
  private watcher: FSWatcher | null = null;
  private watchDirs: string[] = [];

  // Host steward: occupancy + network + ACE component energy
  private steward: HostSteward;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = {
      port: config.port ?? 9070,
      host: config.host ?? "127.0.0.1",
      statsDir: config.statsDir ?? path.join(os.homedir(), ".caitlyn", "stats"),
    };
    if (config.evolutionConfig) this.config.evolutionConfig = config.evolutionConfig;
    if (config.componentRoots) this.config.componentRoots = config.componentRoots;
    if (config.occupancyPollMs !== undefined) this.config.occupancyPollMs = config.occupancyPollMs;
    if (config.componentPollMs !== undefined) this.config.componentPollMs = config.componentPollMs;
    this.evolutionConfig = config.evolutionConfig ?? loadEvolutionConfig();
    this.statsCollector = new StatsCollector(this.config.statsDir!);
    this.statsCollector.load();
    this.evolutionDisabled =
      process.env.CAITLYN_DISABLE_EVOLUTION === "1" ||
      process.env.CAITLYN_DISABLE_EVOLUTION === "true";
    this.occupancyPollMs =
      config.occupancyPollMs ?? DEFAULT_OCCUPANCY_POLL_MS;
    this.componentPollMs =
      config.componentPollMs ?? DEFAULT_COMPONENT_POLL_MS;
    this.steward = new HostSteward({
      statsDir: this.config.statsDir,
      aceWatcher: new AceWatcher({
        roots: config.componentRoots,
        quarantineDir: path.join(this.config.statsDir!, "component-quarantine"),
      }),
    });
  }

  setLlmCall(fn: LlmCallFn): void {
    this.llmCall = fn;
  }

  /** Generator/reviewer pair for the synthesis loop (daemon entry point). */
  setEvolutionLlmPair(generator: LlmCallFn, reviewer: LlmCallFn): void {
    this.generatorLlm = generator;
    this.reviewerLlm = reviewer;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(
        { requestTimeout: REQUEST_TIMEOUT_MS },
        (req, res) => this._handleRequest(req, res),
      );
      this.server.on("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.startTime = Date.now();
        this.collectStats(true)
          .catch(() => {})
          .finally(() => {
            this.startHostWatchLoop();
            resolve();
          });
      });
    });
  }

  async stop(): Promise<void> {
    if (this.occupancyTimer) {
      clearInterval(this.occupancyTimer);
      this.occupancyTimer = null;
    }
    if (this.componentTimer) {
      clearInterval(this.componentTimer);
      this.componentTimer = null;
    }
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

  /**
   * Aggregate new stats events and run an synthesis for each
   * anomaly trigger. Public for tests and manual daemon status checks.
   */
  /** How many host-watch polls have completed since start. */
  getHostWatchPolls(): number {
    return this.hostWatchPolls;
  }

  /**
   * Occupancy always. Component inventory on includeAce ticks.
   */
  startHostWatchLoop(): void {
    if (this.occupancyTimer || this.componentTimer) return;
    this.occupancyTimer = setInterval(() => {
      this.collectStats(false).catch(() => {});
    }, this.occupancyPollMs);
    this.componentTimer = setInterval(() => {
      this.collectStats(true).catch(() => {});
    }, this.componentPollMs);
  }

  async collectStats(includeAce: boolean = true): Promise<AnomalyTrigger[]> {
    if (this.collectInFlight) return [];
    this.collectInFlight = true;
    try {
      return await this.collectStatsBody(includeAce);
    } finally {
      this.collectInFlight = false;
    }
  }

  private async collectStatsBody(includeAce: boolean): Promise<AnomalyTrigger[]> {
    this.hostWatchPolls += 1;
    const snapshot = this.steward.tick(new Date(), includeAce);
    for (const event of snapshot.events) {
      this.statsCollector.appendEvent(event);
    }
    if (snapshot.intervention === "detect") {
      console.error(
        `[daemon] host steward detect-only: energy=${snapshot.energy.toFixed(3)} ` +
          `hot=${snapshot.hotChannels.join(",")}`,
      );
    }
    const triggers = this.statsCollector.collect();
    if (this.evolutionDisabled) {
      return triggers;
    }
    for (const trigger of triggers) {
      appendTriggerRecord(trigger, this.config.statsDir!);
      console.error(
        `[daemon] ⚠️ anomaly: ${trigger.metric}=${trigger.value} ` +
          `(p99 ${trigger.baselineP99}, ewma ${trigger.baselineEwma})`,
      );
      // Occupancy/network spikes are ACE-style detect-only, not skill synthesis.
      if (isOsTelemetrySource(trigger.source)) continue;
      await this.runEvolutionResponse(trigger);
    }
    return triggers;
  }

  /** Run the evolution loop for a statistics-only trigger (unknown path). */
  private async runEvolutionResponse(trigger: AnomalyTrigger): Promise<void> {
    const generator = this.generatorLlm ?? this.llmCall;
    const reviewer = this.reviewerLlm ?? this.llmCall;
    if (!generator || !reviewer) {
      console.error("[daemon] no LLM available — synthesis skipped (record kept).");
      return;
    }
    const engine = new EvolutionEngine({
      config: this.evolutionConfig,
      generatorLlm: generator,
      reviewerLlm: reviewer,
    });
    const clusterId = `stats:${trigger.metric}`;
    try {
      const outcome = await engine.run({
        clusterId,
        target: `statistical anomaly: ${trigger.metric} value ${trigger.value} ` +
          `(baseline p99 ${trigger.baselineP99}, ewma ${trigger.baselineEwma})`,
        profile: {
          clusterId,
          category: "unknown",
          features: [
            `source=${trigger.source}`,
            `metric=${trigger.metric}`,
            `value=${trigger.value}`,
            `baseline_p99=${trigger.baselineP99}`,
            `baseline_ewma=${trigger.baselineEwma}`,
          ],
          sampleCount: 1,
        },
        mustDetect: [],
        benign: [],
        hasSamples: false,
      });
      console.error(
        `[daemon] synthesis done: ${outcome.loop.termination}, ` +
          `${outcome.loop.approved.length} approved, shadow: ${outcome.shadowStarted.join(",")}`,
      );
    } catch (err) {
      console.error(
        `[daemon] synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      } else if (path === "/v1/os-watch" && method === "GET") {
        await this._osWatch(res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large" }));
        return;
      }
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
    let parsed: {
      content?: string;
      source?: string;
      high_risk?: boolean;
      mode?: string;
    } = {};
    try { parsed = JSON.parse(body); } catch { /* invalid JSON handled below */ }

    if (!parsed.content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing 'content' field" }));
      return;
    }

    const content = parsed.content.slice(0, 65536); // 64KB max
    const modeOpts = parseScanMode(parsed.mode);

    let result: ScanResult;
    // Without an LLM, run Tier 0 scripts only (they never need the LLM) and
    // let the scan pipeline mark the degraded mode in its failure path.
    result = await hybridScan({
      content,
      llmCall: this.llmCall ?? createUnavailableLlmCall("LLM not configured on daemon"),
      tier1Mode: modeOpts.tier1Mode,
      mergedScope: modeOpts.mergedScope,
      skipTier0: modeOpts.skipTier0,
      skipTier1: modeOpts.skipTier1,
      sourceTrust:
        parsed.source === "high" || parsed.source === "low"
          ? parsed.source
          : undefined,
      highRisk: parsed.high_risk,
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

    // FSWatcher does not support changing dirs after start — recreate it so
    // the new watch list is actually honored.
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    this.watcher = new FSWatcher(
      { watchDirs: parsed.dirs, quarantineDir: "/tmp/caitlyn-quarantine" },
      this.llmCall,
    );
    this.watcher.start();

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

  private dashboardViewFromSnapshot(
    raw: ReturnType<HostSteward["tick"]>,
  ): HostWatchDashboardView {
    return toHostWatchDashboardView(raw, {
      incidents: readRecentIncidents(this.config.statsDir!, 8),
      polls: this.hostWatchPolls,
      occupancyPollMs: this.occupancyPollMs,
      componentPollMs: this.componentPollMs,
    });
  }

  private async _osWatch(res: http.ServerResponse): Promise<void> {
    const raw = this.steward.getLastSnapshot() ?? this.steward.tick();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.dashboardViewFromSnapshot(raw)));
  }

  private async _status(res: http.ServerResponse): Promise<void> {
    const defenseSkills = loadDefenseSkills();
    const attacks = loadAttacks();

    const status: DaemonStatus = {
      pid: process.pid,
      uptime_ms: Date.now() - this.startTime,
      defense_skills_loaded: defenseSkills.length,
      attacks_loaded: attacks.length,
      scans_total: this.scansTotal,
      scans_blocked: this.scansBlocked,
      scans_flagged: this.scansFlagged,
      scans_allowed: this.scansAllowed,
      watch_dirs: this.watchDirs,
      watch_stats: this.watcher?.getStats() ?? null,
      os_watch: this.steward.getLastSnapshot()
        ? toPublicHostSnapshot(this.steward.getLastSnapshot()!)
        : null,
      host_watch_polls: this.hostWatchPolls,
      occupancy_poll_ms: this.occupancyPollMs,
      component_poll_ms: this.componentPollMs,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes && !rejected) {
        rejected = true;
        reject(new BodyTooLargeError());
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
