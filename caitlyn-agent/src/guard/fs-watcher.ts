/**
 * CAITLYN Guard — FS Watcher
 *
 * Monitors configured directories for file writes and scans new/modified
 * files through the CAITLYN hybrid scanner. Malicious files are moved to
 * a quarantine directory. Suspicious files are tagged.
 *
 * Uses Node.js fs.watch (backed by inotify on Linux) for efficient
 * directory monitoring.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ScanResult } from "../schema.js";
import { createUnavailableLlmCall, type LlmCallFn } from "../scanner.js";
import { hybridScan } from "../hybrid-scanner.js";
import type { GuardConfig, GuardEvent, VerdictAction } from "./types.js";
import { DEFAULT_GUARD_CONFIG } from "./types.js";
import { evaluatePolicy, prepareContent } from "./policy.js";

// ── Types ───────────────────────────────────────────────────────────

/** Supported file types for text extraction. */
export type ExtractableType =
  | "text"       // .txt, .md, .py, .js, .ts, .json, .yaml, .toml, .xml, .html, etc.
  | "pdf"        // .pdf (text layer extraction)
  | "binary";    // unscannable binaries

/** Result of scanning a file. */
export interface FileScanResult {
  filePath: string;
  fileType: ExtractableType;
  extractedText: string | null;
  scanResult: ScanResult | null;
  action: VerdictAction;
  quarantinedPath: string | null;
}

/** FS Watcher statistics. */
export interface FSWatcherStats {
  totalEvents: number;
  filesScanned: number;
  filesBlocked: number;
  filesFlagged: number;
  filesAllowed: number;
  extractionFailures: number;
  scanErrors: number;
}

/** Configuration for the FS Watcher. */
export interface FSWatcherConfig extends GuardConfig {
  /** Directories to watch (recursively). */
  watchDirs: string[];

  /** Patterns to ignore (glob-style, matched against basename). */
  ignorePatterns: string[];

  /** Directory to move quarantined files to. */
  quarantineDir: string;

  /** File extensions to skip (no scanning, no event). */
  skipExtensions: string[];
}

export const DEFAULT_FS_WATCHER_CONFIG: Partial<FSWatcherConfig> = {
  ignorePatterns: [
    "node_modules", ".git", "__pycache__", "*.pyc",
    ".DS_Store", "*.swp", "*.swo", "*.lock",
  ],
  skipExtensions: [
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".ico",
    ".mp3", ".mp4", ".wav", ".ogg",
    ".zip", ".tar", ".gz", ".bz2", ".xz",
    ".bin", ".exe", ".dll", ".so", ".dylib",
  ],
};

// ── Text Extractor Registry ─────────────────────────────────────────

/** Map file extensions to extractable types. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".sh", ".bash", ".zsh", ".fish",
  ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".swift", ".kt", ".scala",
  ".r", ".m", ".sql", ".graphql",
  ".env", ".conf", ".cnf", ".properties",
  ".csv", ".tsv", ".log",
  ".dockerfile", ".makefile", ".cmake",
  ".eml", ".mbox",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);

// ── FS Watcher ──────────────────────────────────────────────────────

export class FSWatcher {
  private config: FSWatcherConfig;
  private stats: FSWatcherStats;
  private llmCall: LlmCallFn | null;
  private watchers: fs.FSWatcher[] = [];
  private running = false;
  private scanQueue: Promise<unknown>[] = [];

  constructor(config: Partial<FSWatcherConfig> = {}, llmCall: LlmCallFn | null = null) {
    this.config = {
      ...DEFAULT_GUARD_CONFIG,
      ...DEFAULT_FS_WATCHER_CONFIG,
      ...config,
    } as FSWatcherConfig;
    this.stats = this._freshStats();
    this.llmCall = llmCall;
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Start watching configured directories. */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const dir of this.config.watchDirs) {
      if (!fs.existsSync(dir)) {
        // Create the directory if it doesn't exist
        fs.mkdirSync(dir, { recursive: true });
      }
      this._watchDir(dir);
    }

    // Ensure quarantine directory exists
    if (!fs.existsSync(this.config.quarantineDir)) {
      fs.mkdirSync(this.config.quarantineDir, { recursive: true });
    }
  }

  /** Stop watching all directories. */
  async stop(): Promise<void> {
    this.running = false;
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    // Wait for in-flight scans
    await Promise.allSettled(this.scanQueue);
    this.scanQueue = [];
  }

  /** Manually scan a file (not waiting for an fs event). */
  async scanFile(filePath: string): Promise<FileScanResult> {
    return this._processFile(filePath);
  }

  /** Get current statistics. */
  getStats(): FSWatcherStats {
    return { ...this.stats };
  }

  /** Reset statistics. */
  resetStats(): void {
    this.stats = this._freshStats();
  }

  /** Set the LLM call function. */
  setLlmCall(llmCall: LlmCallFn): void {
    this.llmCall = llmCall;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private _watchDir(dir: string): void {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (eventType !== "change" && eventType !== "rename") return;
        if (!this.running) return;

        const filePath = path.join(dir, filename);
        // Debounce: fs.watch may fire multiple events for one write
        this._scheduleScan(filePath);
      });

      watcher.on("error", (err) => {
        // Log but don't crash — watcher might fail on deleted directories
        if (this.config.onEvent) {
          this.config.onEvent({
            mode: "fs-watcher",
            content_snippet: "",
            scan_result: {
              verdict: "benign", confidence: 0, tier: 0,
              script_results: [], total_latency_us: 0, total_tokens: 0,
            },
            action: "allow",
            source: dir,
            timestamp: new Date().toISOString(),
            metadata: { error: String(err) },
          });
        }
      });

      this.watchers.push(watcher);
    } catch (err) {
      if (this.config.onEvent) {
        this.config.onEvent({
          mode: "fs-watcher",
          content_snippet: "",
          scan_result: {
            verdict: "benign", confidence: 0, tier: 0,
            script_results: [], total_latency_us: 0, total_tokens: 0,
          },
          action: "allow",
          source: dir,
          timestamp: new Date().toISOString(),
          metadata: { error: String(err) },
        });
      }
    }
  }

  private _pendingScans = new Map<string, NodeJS.Timeout>();

  private _scheduleScan(filePath: string): void {
    // Debounce: clear existing timer for this path, set a new one
    const existing = this._pendingScans.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._pendingScans.delete(filePath);
      // Check file still exists (rename events may fire for deletions)
      if (!fs.existsSync(filePath)) return;
      const promise = this._processFile(filePath);
      this.scanQueue.push(promise);
      // Clean up completed promises periodically
      promise.finally(() => {
        const idx = this.scanQueue.indexOf(promise);
        if (idx >= 0) this.scanQueue.splice(idx, 1);
      });
    }, 100); // 100ms debounce

    this._pendingScans.set(filePath, timer);
  }

  private async _processFile(filePath: string): Promise<FileScanResult> {
    this.stats.totalEvents++;

    // Check ignore patterns
    const basename = path.basename(filePath);
    if (this._matchesIgnore(basename)) {
      return this._skipResult(filePath, "text");
    }

    // Check skip extensions
    const ext = path.extname(filePath).toLowerCase();
    if (this.config.skipExtensions.includes(ext)) {
      return this._skipResult(filePath, "binary");
    }

    // Determine file type
    const fileType = this._classifyFile(filePath);

    // Extract text
    let extractedText: string | null = null;
    try {
      extractedText = this._extractText(filePath, fileType);
    } catch {
      this.stats.extractionFailures++;
      return this._skipResult(filePath, fileType);
    }

    if (extractedText === null) {
      this.stats.extractionFailures++;
      return this._skipResult(filePath, fileType);
    }

    // Skip empty files
    if (extractedText.trim().length === 0) {
      this.stats.filesAllowed++;
      return {
        filePath,
        fileType,
        extractedText: "",
        scanResult: null,
        action: "allow",
        quarantinedPath: null,
      };
    }

    // Scan
    this.stats.filesScanned++;
    let scanResult: ScanResult | null = null;
    let action: VerdictAction = "allow";

    try {
      // Tier 0 scripts never need the LLM: without one, run the unified
      // pipeline with a failing Tier 1 so files are still scanned.
      const content = prepareContent(extractedText, this.config.max_scan_bytes);
      const result = await Promise.race([
        hybridScan({
          content,
          llmCall: this.llmCall ?? createUnavailableLlmCall("LLM not configured"),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("scan timeout")), this.config.scan_timeout_ms),
        ),
      ]);
      scanResult = result;

      const decision = evaluatePolicy({
        mode: "fs-watcher",
        source: filePath,
        content,
        scanResult: result,
        config: this.config,
      });

      action = decision.action;

      if (this.config.onEvent) {
        this.config.onEvent({ ...decision.event, metadata: { filePath, fileType } });
      }
    } catch (err) {
      this.stats.scanErrors++;
      action = "allow"; // Fail-open
      if (this.config.onEvent) {
        this.config.onEvent({
          mode: "fs-watcher",
          content_snippet: extractedText.slice(0, 256),
          scan_result: {
            verdict: "benign", confidence: 0, tier: 0,
            script_results: [], total_latency_us: 0, total_tokens: 0,
          },
          action: "allow",
          source: filePath,
          timestamp: new Date().toISOString(),
          metadata: { error: String(err) },
        });
      }
    }

    // Apply action
    let quarantinedPath: string | null = null;

    if (action === "block") {
      quarantinedPath = this._quarantine(filePath);
      this.stats.filesBlocked++;
    } else if (action === "flag") {
      this.stats.filesFlagged++;
      this._tagFile(filePath, "user.caitlyn-suspicious");
    } else {
      this.stats.filesAllowed++;
    }

    return {
      filePath,
      fileType,
      extractedText,
      scanResult,
      action,
      quarantinedPath,
    };
  }

  // ── File Classification ─────────────────────────────────────────

  private _classifyFile(filePath: string): ExtractableType {
    const ext = path.extname(filePath).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return "text";
    if (PDF_EXTENSIONS.has(ext)) return "pdf";
    return "binary";
  }

  // ── Text Extraction ─────────────────────────────────────────────

  private _extractText(filePath: string, fileType: ExtractableType): string | null {
    switch (fileType) {
      case "text":
        return this._extractPlainText(filePath);
      case "pdf":
        return this._extractPdfText(filePath);
      case "binary":
        return null;
      default:
        return null;
    }
  }

  private _extractPlainText(filePath: string): string {
    // Try UTF-8 first, fall back to Latin-1
    const buf = fs.readFileSync(filePath);
    if (buf.length === 0) return "";
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      // Fall back to Latin-1 (never throws)
      return new TextDecoder("latin1").decode(buf);
    }
  }

  private _extractPdfText(_filePath: string): string | null {
    // PDF text extraction requires a library (pdf-parse, etc.).
    // For now, log and return null — the watcher will report "unscannable".
    // Full implementation: extract text layer with pdf-parse.
    return null;
  }

  // ── Quarantine ──────────────────────────────────────────────────

  private _quarantine(filePath: string): string {
    const basename = path.basename(filePath);
    const timestamp = Date.now();
    const quarantineName = `${timestamp}_${basename}`;
    const quarantinePath = path.join(this.config.quarantineDir, quarantineName);

    try {
      fs.renameSync(filePath, quarantinePath);
      // Write metadata alongside quarantined file
      const metaPath = quarantinePath + ".caitlyn_meta.json";
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            original_path: filePath,
            quarantined_at: new Date().toISOString(),
            reason: "CAITLYN scan verdict: malicious",
          },
          null,
          2,
        ),
        "utf-8",
      );
      return quarantinePath;
    } catch (err) {
      // If rename fails (cross-device), try copy + delete
      try {
        fs.copyFileSync(filePath, quarantinePath);
        fs.unlinkSync(filePath);
        return quarantinePath;
      } catch {
        // Last resort: just log the failure
        return quarantinePath; // path allocated, but operation may have failed
      }
    }
  }

  private _tagFile(filePath: string, _attr: string): void {
    // Extended attributes (xattr) are platform-specific.
    // On Linux: use `setxattr` via fs.promises (Node 22+).
    // For now: write a sidecar file.
    const tagPath = filePath + ".caitlyn-flag";
    try {
      fs.writeFileSync(tagPath, JSON.stringify({
        flagged_at: new Date().toISOString(),
        reason: "CAITLYN scan verdict: suspicious",
      }), "utf-8");
    } catch {
      // Silently ignore — tagging is best-effort
    }
  }

  // ── Pattern Matching ────────────────────────────────────────────

  private _matchesIgnore(basename: string): boolean {
    return this.config.ignorePatterns.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
        );
        return regex.test(basename);
      }
      return basename === pattern;
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private _skipResult(filePath: string, fileType: ExtractableType): FileScanResult {
    return {
      filePath,
      fileType,
      extractedText: null,
      scanResult: null,
      action: "allow",
      quarantinedPath: null,
    };
  }

  private _freshStats(): FSWatcherStats {
    return {
      totalEvents: 0,
      filesScanned: 0,
      filesBlocked: 0,
      filesFlagged: 0,
      filesAllowed: 0,
      extractionFailures: 0,
      scanErrors: 0,
    };
  }
}
