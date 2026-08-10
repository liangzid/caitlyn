/**
 * CAITLYN Agent — Scanning Engine
 *
 * Two-tier scanning:
 *   Tier 0: Run detect.ts scripts in parallel sandboxes (fast, regex/heuristics)
 *   Tier 1: Assemble all antibodies + antigens into one LLM prompt, output single token
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AntibodyEntry,
  AntigenEntry,
  ScanResult,
  ScriptResult,
  Verdict,
} from "./schema.js";
import { logScan } from "./history.js";
import { recordScanFeedback } from "./library.js";
import { recordShadowScans } from "./evolution/runtime.js";
import { appendStatsEvent } from "./evolution/stats-events.js";

// ── Tier 0: Sandbox Script Runner ─────────────────────────────────

interface RunScriptOptions {
  content: string;
  scriptPath: string;
  antibodyId: string;
  timeoutMs: number;
}

function runScript(opts: RunScriptOptions): Promise<ScriptResult> {
  const start = performance.now();
  const { promise, resolve } = Promise.withResolvers<ScriptResult>();

  // Prefer precompiled .mjs (50ms) over npx tsx (500ms)
  const compiledPath = opts.scriptPath.replace(/\.ts$/, ".mjs");
  const useCompiled = fs.existsSync(compiledPath);
  const cmd = useCompiled ? "node" : "npx";
  const args = useCompiled ? [compiledPath] : ["tsx", opts.scriptPath];

  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let stdout = "";
  let stderr = "";
  let killed = false;
  let settled = false;

  const settle = (result: ScriptResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, opts.timeoutMs);

  child.on("error", (err) => {
    settle({
      antibody_id: opts.antibodyId,
      verdict: "benign",
      confidence: 0,
      reason: null,
      latency_us: 0,
      error: `Failed to spawn script: ${err.message}`,
    });
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  child.on("close", (code) => {
    const latency = Math.round(performance.now() - start) * 1000;

    if (killed) {
      settle({
        antibody_id: opts.antibodyId,
        verdict: "benign",
        confidence: 0,
        reason: null,
        latency_us: latency,
        error: `Script timed out after ${opts.timeoutMs}ms`,
      });
      return;
    }

    if (code !== 0) {
      settle({
        antibody_id: opts.antibodyId,
        verdict: "benign",
        confidence: 0,
        reason: null,
        latency_us: latency,
        error: stderr.trim() || `Script exited with code ${code}`,
      });
      return;
    }

    try {
      const parsed = JSON.parse(stdout.trim());
      const verdict = parsed.verdict;
      settle({
        antibody_id: opts.antibodyId,
        verdict: verdict === "malicious" ? "malicious" : verdict === "suspicious" ? "suspicious" : "benign",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reason: parsed.reason ?? null,
        latency_us: latency,
        error: null,
      });
    } catch {
      settle({
        antibody_id: opts.antibodyId,
        verdict: "benign",
        confidence: 0,
        reason: null,
        latency_us: latency,
        error: `Invalid JSON output: ${stdout.slice(0, 200)}`,
      });
    }
  });
  // Safe stdin write: handle backpressure and errors
  const stdin = child.stdin;
  if (stdin) {
    stdin.on("error", (err) => {
      if (!settled) {
        settle({
          antibody_id: opts.antibodyId,
          verdict: "benign",
          confidence: 0,
          reason: null,
          latency_us: 0,
          error: `stdin write error: ${err.message}`,
        });
      }
    });
    const ok = stdin.write(opts.content);
    if (!ok) {
      stdin.once("drain", () => stdin.end());
    } else {
      stdin.end();
    }
  }

  return promise;
}

export async function runTier0(
  antibodies: AntibodyEntry[],
  content: string,
  timeoutMs: number = 500,
): Promise<{ results: ScriptResult[]; malicious: boolean }> {
  const tier0Antibodies = antibodies.filter(
    (ab) => ab.config.tier === 0 && ab.config.role === "detector",
  );

  if (tier0Antibodies.length === 0) {
    return { results: [], malicious: false };
  }

  const results: ScriptResult[] = [];
  const scriptPromises: Promise<ScriptResult>[] = [];
  for (const ab of tier0Antibodies) {
    if (ab.scriptPath) {
      // Hand-written detectors (advanced heuristics) run as scripts.
      scriptPromises.push(
        runScript({
          content,
          scriptPath: ab.scriptPath,
          antibodyId: ab.config.id,
          timeoutMs,
        }),
      );
    } else {
      // Signature-only detectors (including evolution-created ones) run
      // through the generic in-process signature engine.
      const sigResult = matchSignatures(ab, content);
      if (sigResult) results.push(sigResult);
    }
  }
  results.push(...(await Promise.all(scriptPromises)));

  // Short-circuit: any high-confidence malicious from Tier 0
  const malicious = results.some(
    (r) => r.verdict === "malicious" && r.confidence >= 0.6,
  );

  return { results, malicious };
}

/**
 * Generic signature engine for Tier 0 antibodies that have config
 * signatures but no hand-written detect.ts script. This is what makes
 * evolution-created antibodies (signatures only) actually executable.
 *
 * REVIEW(团长): 单签名命中按 0.6 置信度计为恶意票；多签名命中小幅加分。
 * 阈值和置信度公式后续应按 benign 集校准，而不是写死在这里。
 */
export function matchSignatures(
  ab: AntibodyEntry,
  content: string,
): ScriptResult | null {
  const matched: string[] = [];
  for (const sig of ab.config.signatures) {
    let hit = false;
    if (sig.type === "regex") {
      try {
        hit = new RegExp(sig.pattern, "i").test(content);
      } catch {
        // A malformed signature must not crash the scan; the integrity
        // audit flags it separately.
      }
    } else {
      hit = content.toLowerCase().includes(sig.pattern.toLowerCase());
    }
    if (hit) matched.push(sig.label || sig.pattern);
  }
  if (matched.length === 0) return null;
  return {
    antibody_id: ab.config.id,
    verdict: "malicious",
    confidence: Math.min(1, 0.6 + 0.05 * (matched.length - 1)),
    reason: `matched signatures: ${matched.join(", ")}`,
    latency_us: 0,
    error: null,
  };
}

// ── Tier 1: LLM Single-Token Classifier ───────────────────────────

export interface LlmCallFn {
  (systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * Parse Tier 1 LLM response.
 * Expected format: "verdict confidence" (e.g., "malicious 0.92").
 * Falls back to legacy single-digit format: 0 = benign, 1 = malicious.
 */
export function parseTier1Response(
  raw: string,
): { verdict: "benign" | "suspicious" | "malicious"; confidence: number } {
  // Try new format: "<verdict> <confidence>"
  const match = raw.match(/^(benign|suspicious|malicious)\s+([\d.]+)$/i);
  if (match) {
    return {
      verdict: match[1].toLowerCase() as "benign" | "suspicious" | "malicious",
      confidence: parseFloat(match[2]),
    };
  }

  // Fallback to legacy single-digit format: 0 = benign, 1 = malicious
  if (raw === "0") {
    return { verdict: "benign", confidence: 0.95 };
  }
  if (raw === "1") {
    return { verdict: "malicious", confidence: 0.8 };
  }

  // Unknown format — fail toward caution: mark suspicious with low confidence
  // so malformed LLM output cannot silently pass as benign.
  return { verdict: "suspicious", confidence: 0.5 };
}

/**
 * Build an LLM call function that always fails.
 * Used to run Tier 0-only scans (scripts never need the LLM) while keeping
 * the unified scan() pipeline; the failure path reports the degraded mode.
 */
export function createUnavailableLlmCall(reason: string): LlmCallFn {
  return async () => {
    throw new Error(reason);
  };
}

/**
 * Derive a conservative verdict from Tier 0 results when Tier 1 is
 * unavailable: any malicious vote wins; detectors that report weak
 * signals as "suspicious" are promoted, everything else stays benign.
 */
function deriveTier0Verdict(
  results: ScriptResult[],
): { verdict: "benign" | "suspicious" | "malicious"; confidence: number } {
  const malicious = results.filter((r) => r.verdict === "malicious");
  if (malicious.length > 0) {
    return {
      verdict: "malicious",
      confidence: Math.max(...malicious.map((r) => r.confidence)),
    };
  }

  const signals = results.filter(
    (r) => r.verdict === "suspicious",
  );
  if (signals.length > 0) {
    return {
      verdict: "suspicious",
      confidence: Math.max(...signals.map((r) => r.confidence)),
    };
  }

  return { verdict: "benign", confidence: 0 };
}

/**
 * Build the prompt pair for ONE antibody. The antibody's own config
 * prompt is its executable knowledge; we append a strict output contract
 * so parseTier1Response can consume the answer reliably.
 */
export function buildAntibodyPrompt(
  ab: AntibodyEntry,
  content: string,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are the defense skill "${ab.config.name}" (${ab.config.id}).

${ab.config.prompt}

Output EXACTLY one line with a verdict and a confidence score:
"benign <number>", "suspicious <number>", or "malicious <number>".
Confidence must be a number between 0.0 and 1.0.
Do not output anything else.`;

  const userPrompt = `<content>\n${content}\n</content>`;

  return { systemPrompt, userPrompt };
}

/** Tier 1 detectors that actually run in the ensemble. */
export function selectTier1Detectors(antibodies: AntibodyEntry[]): AntibodyEntry[] {
  return antibodies.filter(
    (ab) =>
      ab.config.role === "detector" &&
      ab.config.tier > 0 &&
      ab.config.prompt.trim().length > 0,
  );
}

export interface Tier1Result extends ScriptResult {
  tokens: number;
}

/**
 * Run every Tier 1/2 detector as its own parallel LLM call, so each
 * antibody's prompt is genuinely executed and its verdict can be
 * attributed back to the antibody.
 *
 * REVIEW(团长): 这是把"一个聚合 LLM + 空库"改成"每个抗体独立投票"的关键
 * 决策。成本近似等于检测器数量 × 单次调用；并行下延迟与单次调用相当。
 * 若成本不可接受，下一版用 escalation-coordinator 做分级触发。
 */
export async function runTier1Ensemble(
  antibodies: AntibodyEntry[],
  content: string,
  llmCall: LlmCallFn,
): Promise<Tier1Result[]> {
  const detectors = selectTier1Detectors(antibodies);
  if (detectors.length === 0) return [];

  const jobs = detectors.map(async (ab) => {
    const start = performance.now();
    const { systemPrompt, userPrompt } = buildAntibodyPrompt(ab, content);
    try {
      const raw = await llmCall(systemPrompt, userPrompt);
      const parsed = parseTier1Response(raw.trim());
      return {
        antibody_id: ab.config.id,
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        reason: null,
        latency_us: Math.round(performance.now() - start) * 1000,
        error: null,
        tokens: estimateScanTokens(systemPrompt, userPrompt, raw),
      } satisfies Tier1Result;
    } catch (err) {
      return {
        antibody_id: ab.config.id,
        verdict: "benign" as const,
        confidence: 0,
        reason: null,
        latency_us: Math.round(performance.now() - start) * 1000,
        error: err instanceof Error ? err.message : String(err),
        tokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt),
      } satisfies Tier1Result;
    }
  });

  const results = await Promise.all(jobs);
  if (results.every((r) => r.error)) {
    throw new Error(
      `All Tier 1 detectors failed: ${results.map((r) => r.error).join("; ")}`,
    );
  }
  return results;
}

/**
 * Aggregate the ensemble: any fired malicious vote wins; otherwise any
 * suspicious signal; otherwise benign. "Fired" means the detector said
 * malicious with confidence at or above that antibody's threshold.
 */
export function aggregateTier1(
  results: Tier1Result[],
  thresholds: ReadonlyMap<string, number>,
): { verdict: "benign" | "suspicious" | "malicious"; confidence: number } {
  const fired = results.filter(
    (r) =>
      r.verdict === "malicious" &&
      r.confidence >= (thresholds.get(r.antibody_id) ?? 0.6),
  );
  if (fired.length > 0) {
    return {
      verdict: "malicious",
      confidence: Math.max(...fired.map((r) => r.confidence)),
    };
  }

  const suspicious = results.filter((r) => r.verdict === "suspicious");
  if (suspicious.length > 0) {
    return {
      verdict: "suspicious",
      confidence: Math.max(...suspicious.map((r) => r.confidence)),
    };
  }

  return { verdict: "benign", confidence: 0 };
}

// ── Unified Scan Pipeline ─────────────────────────────────────────

export interface ScanOptions {
  antibodies: AntibodyEntry[];
  antigens: AntigenEntry[];
  content: string;
  llmCall: LlmCallFn;
  tier0TimeoutMs?: number;
}

/** Approximate token count (4 characters per token, like evolution). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated Tier 1 cost: prompt (system + user) plus the LLM output. */
export function estimateScanTokens(
  systemPrompt: string,
  userPrompt: string,
  output: string,
): number {
  return estimateTokens(systemPrompt) + estimateTokens(userPrompt) + estimateTokens(output);
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const scanStart = performance.now();
  let totalTokens = 0;

  // Tier 0: fast scripts + signature engine
  const t0 = await runTier0(options.antibodies, options.content, options.tier0TimeoutMs);
  recordShadowScans(options.content);

  const t0Feedback = (finalVerdict: Verdict) =>
    recordScanFeedback(
      t0.results.map((r) => ({
        antibody_id: r.antibody_id,
        verdict: r.verdict,
        confidence: r.confidence,
        latency_us: r.latency_us,
        fired: r.verdict === "malicious" && r.confidence >= 0.6,
      })),
      finalVerdict,
    );

  if (t0.malicious) {
    const latency = Math.round(performance.now() - scanStart) * 1000;
    appendStatsEvent("evolution_self", "scan_latency_us", latency);
    const result: ScanResult = {
      verdict: "malicious",
      confidence: Math.max(...t0.results.map((r) => r.confidence)),
      tier: 0,
      script_results: t0.results,
      total_latency_us: latency,
      total_tokens: 0,
    };
    await logScan(result, options.content);
    t0Feedback(result.verdict);
    return result;
  }

  const thresholds = new Map(
    options.antibodies.map((ab) => [ab.config.id, ab.config.threshold]),
  );

  // Tier 1: real per-antibody LLM ensemble. If the library has no LLM
  // detectors configured, degrade to the Tier 0 verdict instead of
  // calling a generic judge with an empty library.
  if (selectTier1Detectors(options.antibodies).length === 0) {
    const latency = Math.round(performance.now() - scanStart) * 1000;
    appendStatsEvent("evolution_self", "scan_latency_us", latency);
    const fallback = deriveTier0Verdict(t0.results);
    const result: ScanResult = {
      verdict: fallback.verdict,
      confidence: fallback.confidence,
      tier: 1,
      script_results: [
        ...t0.results,
        {
          antibody_id: "no-tier1-detectors",
          verdict: "benign" as const,
          confidence: 0,
          reason: "No Tier 1 detectors configured in the antibody library",
          latency_us: 0,
          error: null,
        },
      ],
      total_latency_us: latency,
      total_tokens: 0,
    };
    await logScan(result, options.content);
    t0Feedback(result.verdict);
    return result;
  }

  try {
    const t1 = await runTier1Ensemble(options.antibodies, options.content, options.llmCall);
    totalTokens = t1.reduce((acc, r) => acc + r.tokens, 0);
    const aggregated = aggregateTier1(t1, thresholds);
    const latency = Math.round(performance.now() - scanStart) * 1000;
    appendStatsEvent("evolution_self", "scan_latency_us", latency);
    appendStatsEvent("evolution_self", "scan_tokens", totalTokens);

    const t1ScriptResults: ScriptResult[] = t1.map(({ tokens: _tokens, ...rest }) => rest);
    const result: ScanResult = {
      verdict: aggregated.verdict,
      confidence: aggregated.confidence,
      tier: 1,
      script_results: [...t0.results, ...t1ScriptResults],
      total_latency_us: latency,
      total_tokens: totalTokens,
    };

    // Persist to scan history
    await logScan(result, options.content);

    // Attribute the verdict to every participating antibody so each
    // detector accumulates real scan counts, TP, and FP independently.
    recordScanFeedback(
      [
        ...t0.results.map((r) => ({
          antibody_id: r.antibody_id,
          verdict: r.verdict,
          confidence: r.confidence,
          latency_us: r.latency_us,
          fired: r.verdict === "malicious" && r.confidence >= 0.6,
        })),
        ...t1.map((r) => ({
          antibody_id: r.antibody_id,
          verdict: r.verdict,
          confidence: r.confidence,
          latency_us: r.latency_us,
          fired:
            r.verdict === "malicious" &&
            r.confidence >= (thresholds.get(r.antibody_id) ?? 0.6),
        })),
      ],
      result.verdict,
    );

    return result;
  } catch (err) {
    // LLM failed — fall back to Tier 0 results only
    const latency = Math.round(performance.now() - scanStart) * 1000;
    const errorMsg = err instanceof Error ? err.message : String(err);
    appendStatsEvent("evolution_self", "scan_latency_us", latency);
    const fallback = deriveTier0Verdict(t0.results);
    const result: ScanResult = {
      verdict: fallback.verdict,
      confidence: fallback.confidence,
      tier: 1,
      script_results: [
        ...t0.results,
        {
          antibody_id: "llm-fallback",
          verdict: "benign" as const,
          confidence: 0,
          reason: `LLM unavailable, Tier 1 skipped. Error: ${errorMsg}`,
          latency_us: 0,
          error: errorMsg,
        },
      ],
      total_latency_us: latency,
      total_tokens: totalTokens,
    };

    await logScan(result, options.content);
    t0Feedback(fallback.verdict);
    return result;
  }
}
