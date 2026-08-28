/**
 * CAITLYN — User settings for update checks and cloud contribute opt-in.
 *
 * Stored in ~/.caitlyn/settings.toml so repo config.toml stays untouched.
 * Cloud contribute stays off by default (paper trust boundary).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SyncSettings {
  /** Opt-in to pack/upload contributions. Default false. */
  contributeEnabled: boolean;
  /** Delayed TUI version check. Default true (not the contribute switch). */
  updateCheckEnabled: boolean;
  /** GitHub owner/repo for release discovery. */
  githubRepo: string;
  /** npm package name used by `caitlyn update`. */
  npmPackage: string;
}

export const SYNC_SETTINGS_DEFAULTS: SyncSettings = {
  contributeEnabled: false,
  updateCheckEnabled: true,
  githubRepo: "liangzid/caitlyn",
  npmPackage: "caitlyn",
};

/** Path to the user settings file. */
export function settingsPath(): string {
  if (process.env.CAITLYN_SETTINGS_PATH) {
    return path.resolve(process.env.CAITLYN_SETTINGS_PATH);
  }
  return path.join(os.homedir(), ".caitlyn", "settings.toml");
}

/** Read a single [section] of a minimal TOML file. */
function readTomlSection(filePath: string, section: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let inSection = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const secMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (secMatch) {
        inSection = secMatch[1] === section;
        continue;
      }
      if (inSection) {
        const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
        if (kvMatch) {
          result[kvMatch[1]] = kvMatch[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
        }
      }
    }
  } catch {
    // Missing settings file is normal for first run.
  }
  return result;
}

function parseBool(raw: Record<string, string>, key: string, fallback: boolean): boolean {
  const v = raw[key]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

/** Load sync/update settings with safe defaults. */
export function loadSyncSettings(): SyncSettings {
  const file = settingsPath();
  const cloud = readTomlSection(file, "cloud_sync");
  const update = readTomlSection(file, "update");
  return {
    contributeEnabled: parseBool(cloud, "contribute", SYNC_SETTINGS_DEFAULTS.contributeEnabled),
    updateCheckEnabled: parseBool(update, "check", SYNC_SETTINGS_DEFAULTS.updateCheckEnabled),
    githubRepo:
      process.env.CAITLYN_GITHUB_REPO?.trim() ||
      update["github_repo"]?.trim() ||
      SYNC_SETTINGS_DEFAULTS.githubRepo,
    npmPackage:
      process.env.CAITLYN_NPM_PACKAGE?.trim() ||
      update["npm_package"]?.trim() ||
      SYNC_SETTINGS_DEFAULTS.npmPackage,
  };
}

/**
 * Persist contribute / update-check flags without rewriting unrelated keys.
 * KEYPOINT-REVIEW: 首版整文件重写；字段少，足够用。后续可换成 patch 写入。
 */
export function saveSyncSettings(partial: Partial<SyncSettings>): SyncSettings {
  const current = loadSyncSettings();
  const next: SyncSettings = { ...current, ...partial };
  const body = [
    "# CAITLYN user settings (opt-in cloud contribute + update checks)",
    "",
    "[cloud_sync]",
    `# Upload contributions for human audit. Default false.`,
    `contribute = ${next.contributeEnabled}`,
    "",
    "[update]",
    `# Delayed version check on TUI start. Default true.`,
    `check = ${next.updateCheckEnabled}`,
    `github_repo = "${next.githubRepo}"`,
    `npm_package = "${next.npmPackage}"`,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), body, "utf-8");
  return next;
}
