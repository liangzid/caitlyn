/**
 * CAITLYN setup configuration writer.
 *
 * Replaces only setup-owned TOML sections, preserves all unrelated content,
 * creates a recoverable backup, and publishes changes with an atomic rename.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CaitlynAgentConfig,
  GuardRuntimeConfig,
  ScanningConfig,
} from "../config.js";

/** Complete setup-owned configuration document. API keys are never included. */
export interface SetupConfigDocument {
  llm: CaitlynAgentConfig;
  scanning: ScanningConfig;
  guard: GuardRuntimeConfig;
}

/** Result of a safe configuration write. */
export interface SetupConfigWriteResult {
  configPath: string;
  changed: boolean;
  backupPath: string | null;
}

/** Escape a value for a TOML basic string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render the [llm] section managed by the setup wizard. */
function renderLlmSection(config: CaitlynAgentConfig): string {
  return [
    "[llm]",
    `provider = ${tomlString(config.provider)}`,
    `model = ${tomlString(config.model)}`,
    `small_model = ${tomlString(config.smallModel)}`,
  ].join("\n");
}

/** Render detailed Tier 0 and Tier 1 detection settings. */
function renderScanningSection(config: ScanningConfig): string {
  return [
    "[scanning]",
    `tier1_mode = ${tomlString(config.tier1Mode)}`,
    `merged_scope = ${tomlString(config.mergedScope)}`,
    `skip_tier0 = ${config.skipTier0}`,
    `skip_tier1 = ${config.skipTier1}`,
    `tier0_timeout_ms = ${config.tier0TimeoutMs}`,
    `escalation_policy = ${tomlString(config.policy)}`,
    `fast_detector_ids = ${tomlString(config.fastDetectorIds.join(","))}`,
    `weak_signal_threshold = ${config.weakSignalThreshold}`,
    `source_trust = ${tomlString(config.sourceTrust)}`,
    `high_risk = ${config.highRisk}`,
    `tier1_timeout_ms = ${config.tier1TimeoutMs}`,
    `max_parallel_tier1 = ${config.maxParallelTier1}`,
  ].join("\n");
}

/** Render Agent hook coverage, failure, and verdict policy settings. */
function renderGuardSection(config: GuardRuntimeConfig): string {
  return [
    "[guard]",
    `enabled = ${config.enabled}`,
    `before_enabled = ${config.beforeEnabled}`,
    `after_enabled = ${config.afterEnabled}`,
    `hook_timeout_ms = ${config.hookTimeoutMs}`,
    `max_scan_bytes = ${config.maxScanBytes}`,
    `on_error = ${tomlString(config.onError)}`,
    `suspicious_action = ${tomlString(config.suspiciousAction)}`,
    `malicious_action = ${tomlString(config.maliciousAction)}`,
  ].join("\n");
}

/** Replace or append one top-level TOML table without touching other tables. */
export function upsertTomlSection(
  source: string,
  sectionName: string,
  replacement: string,
): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const headerPattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const start = lines.findIndex((line) => headerPattern.exec(line)?.[1] === sectionName);

  if (start < 0) {
    const trimmed = source.replace(/\s+$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}${replacement}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !headerPattern.test(lines[end])) end++;
  lines.splice(start, end - start, ...replacement.split("\n"), "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

/** Merge all setup-owned sections into an existing TOML document. */
export function mergeSetupConfig(
  source: string,
  document: SetupConfigDocument,
): string {
  let merged = upsertTomlSection(source, "llm", renderLlmSection(document.llm));
  merged = upsertTomlSection(merged, "scanning", renderScanningSection(document.scanning));
  merged = upsertTomlSection(merged, "guard", renderGuardSection(document.guard));
  return merged;
}

/** Produce a filesystem-safe UTC timestamp for backup names. */
function backupTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

/** Atomically write setup configuration and preserve the previous file. */
export function writeSetupConfig(
  configPath: string,
  document: SetupConfigDocument,
): SetupConfigWriteResult {
  const resolvedPath = path.resolve(configPath);
  const exists = fs.existsSync(resolvedPath);
  const original = exists ? fs.readFileSync(resolvedPath, "utf-8") : "";
  const merged = mergeSetupConfig(original, document);
  if (original === merged) {
    return { configPath: resolvedPath, changed: false, backupPath: null };
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  let backupPath: string | null = null;
  if (exists) {
    backupPath = `${resolvedPath}.caitlyn-backup-${backupTimestamp()}`;
    fs.copyFileSync(resolvedPath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const temporary = `${resolvedPath}.tmp-${process.pid}-${Date.now()}`;
  const mode = exists ? fs.statSync(resolvedPath).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(temporary, merged, { encoding: "utf-8", mode });
    fs.renameSync(temporary, resolvedPath);
    fs.chmodSync(resolvedPath, mode);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* temporary file may not exist */ }
    throw error;
  }

  return { configPath: resolvedPath, changed: true, backupPath };
}

/** Restore the pre-setup file after a failed round-trip validation. */
export function rollbackSetupConfig(result: SetupConfigWriteResult): void {
  if (!result.changed) return;
  if (result.backupPath) {
    fs.copyFileSync(result.backupPath, result.configPath);
    return;
  }
  if (fs.existsSync(result.configPath)) fs.unlinkSync(result.configPath);
}
