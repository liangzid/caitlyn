/**
 * CAITLYN prompt privacy boundary.
 *
 * Outbound text is what a model is about to read: tool output, and any
 * string passed to `protectOutbound`. Inbound text is what a local tool
 * is about to execute: surrogates created earlier are restored, and raw
 * secrets the model already produced are left for the tool.
 *
 * GemFilter supplies the session idea (detect, surrogate, restore on the
 * local side of the boundary). Prεεmpt supplies the two transforms:
 * format-preserving encryption for format-dependent tokens, and metric
 * differential privacy for value-dependent numbers.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { laplaceNoise, transformDigits, transformEmail } from "./cipher.js";
import type { PrivacyLevel } from "../config.js";
import { builtinPrivacyRules, type PrivacyRule } from "./rules.js";
import { PrivacyVault } from "./vault.js";

export interface ProtectResult {
  text: string;
  changed: boolean;
  count: number;
}

interface Span {
  start: number;
  end: number;
  replacement: string;
}

const vaults = new Map<string, PrivacyVault>();

/**
 * Return the per-user vault, creating `~/.caitlyn/privacy.key` on first use.
 */
export function defaultPrivacyVault(): PrivacyVault {
  const root = path.join(os.homedir(), ".caitlyn");
  const existing = vaults.get(root);
  if (existing) return existing;
  const vault = PrivacyVault.open(root);
  vaults.set(root, vault);
  return vault;
}

/**
 * Replace sensitive spans before the text is shown to a model.
 */
export function protectOutbound(
  text: string,
  vault: PrivacyVault = defaultPrivacyVault(),
  level: PrivacyLevel = "standard",
): ProtectResult {
  if (level === "off") return { text, changed: false, count: 0 };
  return applySpans(text, collectSpans(text, vault, level));
}

/**
 * Restore surrogates that this vault created, before a local tool runs.
 * Metric-DP numbers are intentionally left noisy.
 */
export function restoreInbound(text: string, vault: PrivacyVault = defaultPrivacyVault()): ProtectResult {
  const spans: Span[] = [];
  for (const surrogate of vault.surrogates()) {
    if (!surrogate) continue;
    let from = 0;
    while (from <= text.length) {
      const start = text.indexOf(surrogate, from);
      if (start < 0) break;
      const original = vault.lookup(surrogate);
      if (original !== undefined) {
        spans.push({ start, end: start + surrogate.length, replacement: original });
      }
      from = start + surrogate.length;
    }
  }
  return applySpans(text, spans);
}

/**
 * CLI entry: `caitlyn privacy sanitize|restore [--level standard|strict] <text>`.
 * The command itself is an explicit request, so the default level is standard.
 * Prints only the transformed text. The count goes to stderr.
 */
export function runPrivacyCommand(argv: string[]): void {
  const args = [...argv];
  const levelFlag = args.indexOf("--level");
  let level: PrivacyLevel = "standard";
  if (levelFlag >= 0) {
    const value = args[levelFlag + 1];
    if (value !== "standard" && value !== "strict") {
      process.stderr.write("Usage: caitlyn privacy <sanitize|restore> [--level standard|strict] <text>\n");
      process.exit(1);
    }
    level = value;
    args.splice(levelFlag, 2);
  }
  const mode = args[0];
  const text = args.slice(1).join(" ");
  if ((mode !== "sanitize" && mode !== "restore") || !text) {
    process.stderr.write("Usage: caitlyn privacy <sanitize|restore> [--level standard|strict] <text>\n");
    process.exit(1);
  }
  const result = mode === "sanitize" ? protectOutbound(text, defaultPrivacyVault(), level) : restoreInbound(text);
  process.stderr.write(`caitlyn privacy: ${result.count} span(s) at ${level}\n`);
  process.stdout.write(result.text + "\n");
}

/**
 * Find non-overlapping sensitive spans in priority order.
 */
function collectSpans(text: string, vault: PrivacyVault, level: PrivacyLevel): Span[] {
  const rules = builtinPrivacyRules()
    .filter((rule) => level === "strict" || rule.klass !== "metric")
    .slice()
    .sort((a, b) => a.priority - b.priority);
  const spans: Span[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const bounds = groupBounds(match, rule.valueGroup);
      if (!bounds) continue;
      const raw = text.slice(bounds.start, bounds.end);
      if (!raw || (rule.accept && !rule.accept(raw))) continue;
      const candidate = { start: bounds.start, end: bounds.end };
      if (spans.some((span) => span.start < candidate.end && candidate.start < span.end)) continue;
      const replacement = renderSpan(rule, raw, vault);
      if (replacement === raw) continue;
      spans.push({ ...candidate, replacement });
    }
  }
  return spans;
}

/**
 * Read a capture group's offsets. Patterns are compiled with the `d` flag.
 */
function groupBounds(match: RegExpMatchArray, group: number): { start: number; end: number } | null {
  const indices = (match as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
  const pair = indices?.[group];
  if (!pair) return null;
  return { start: pair[0], end: pair[1] };
}

/**
 * Render one detected value as a surrogate and remember reversible ones.
 */
function renderSpan(rule: PrivacyRule, raw: string, vault: PrivacyVault): string {
  if (rule.klass === "metric") return renderMetric(raw, rule, vault);
  if (rule.klass === "secret") return renderSecret(rule, raw, vault);
  const domain = rule.domain ?? rule.name;
  const next = rule.name === "email"
    ? transformEmail(raw, vault.key, false)
    : transformDigits(raw, vault.key, domain, false);
  if (next !== raw) vault.remember(next, raw);
  return next;
}

/**
 * Replace a secret with a stable typed placeholder.
 * KEYPOINT-REVIEW: the placeholder is an HMAC tag, not ciphertext.
 * Restoring it requires the local vault. The model never receives the key.
 */
function renderSecret(rule: PrivacyRule, raw: string, vault: PrivacyVault): string {
  const label = rule.label ?? rule.name.toUpperCase();
  const mac = crypto.createHmac("sha256", vault.key).update(`secret|${rule.name}|${raw}`).digest("hex").slice(0, 8);
  const surrogate = `<${label}_${mac}>`;
  vault.remember(surrogate, raw);
  return surrogate;
}

/**
 * Add Laplace noise scaled by unit/epsilon and clamp to the declared domain.
 * The noisy value is not stored, matching Prεεmpt's stateless Category II.
 */
function renderMetric(raw: string, rule: PrivacyRule, vault: PrivacyVault): string {
  const spec = rule.metric;
  if (!spec) return raw;
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const noisy = value + laplaceNoise(spec.unit / spec.epsilon, vault.random());
  const clamped = Math.min(spec.max, Math.max(spec.min, noisy));
  const places = decimalPlaces(raw);
  return clamped.toFixed(places);
}

/**
 * Count digits after the decimal point so an integer stays an integer.
 */
function decimalPlaces(raw: string): number {
  const dot = raw.indexOf(".");
  if (dot < 0) return 0;
  return raw.length - dot - 1;
}

/**
 * Apply span replacements from the end so earlier offsets stay valid.
 */
function applySpans(text: string, spans: Span[]): ProtectResult {
  const ordered = dropOverlaps(spans).sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of ordered) {
    out = out.slice(0, span.start) + span.replacement + out.slice(span.end);
  }
  return { text: out, changed: out !== text, count: ordered.length };
}

/**
 * Keep the longer span when two replacements cover the same characters.
 */
function dropOverlaps(spans: Span[]): Span[] {
  const ordered = spans.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept: Span[] = [];
  for (const span of ordered) {
    if (kept.some((other) => other.start < span.end && span.start < other.end)) continue;
    kept.push(span);
  }
  return kept;
}
