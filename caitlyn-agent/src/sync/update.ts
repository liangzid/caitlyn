/**
 * CAITLYN — Version discovery (GitHub Releases) and npm-backed update apply.
 *
 * Discovery source of truth: GitHub release tag.
 * Apply path for v1: npm install of the configured package.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSyncSettings } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  error?: string;
}

/** Read the installed package version from package.json. */
export function currentPackageVersion(): string {
  const pkgPath = path.resolve(__dirname, "../../package.json");
  try {
    const raw = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return raw.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Compare semver-ish tags (strips leading v). Returns true if latest > current. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * Fetch latest GitHub release tag for the configured repo.
 * Honors CAITLYN_OFFLINE / update.check=false via caller.
 */
export async function fetchLatestGithubRelease(
  githubRepo?: string,
): Promise<{ tag: string; htmlUrl: string } | null> {
  const repo = githubRepo ?? loadSyncSettings().githubRepo;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "caitlyn-update-check",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!body.tag_name) return null;
    return { tag: body.tag_name, htmlUrl: body.html_url ?? `https://github.com/${repo}/releases` };
  } catch {
    return null;
  }
}

/** Compare installed version against GitHub latest release. */
export async function checkForUpdate(): Promise<VersionCheckResult> {
  const current = currentPackageVersion();
  if (process.env.CAITLYN_OFFLINE === "1") {
    return {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      error: "offline",
    };
  }
  const settings = loadSyncSettings();
  if (!settings.updateCheckEnabled) {
    return {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      error: "check-disabled",
    };
  }
  const release = await fetchLatestGithubRelease(settings.githubRepo);
  if (!release) {
    return {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      error: "fetch-failed",
    };
  }
  const latest = release.tag.replace(/^v/i, "");
  return {
    current,
    latest,
    updateAvailable: isNewerVersion(latest, current),
    releaseUrl: release.htmlUrl,
  };
}

/**
 * Apply update via npm (global install of the configured package @ latest).
 * KEYPOINT-REVIEW: v1 只做 npm-only apply；git-clone 工作流打印手动指引。
 */
export function applyNpmUpdate(version?: string): { ok: boolean; command: string; detail: string } {
  const settings = loadSyncSettings();
  const spec = version
    ? `${settings.npmPackage}@${version.replace(/^v/i, "")}`
    : `${settings.npmPackage}@latest`;
  const command = `npm install -g ${spec}`;
  const result = spawnSync("npm", ["install", "-g", spec], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return { ok: true, command, detail: result.stdout?.trim() || "ok" };
  }
  const err = (result.stderr || result.stdout || "npm failed").trim();
  return { ok: false, command, detail: err };
}

/** CLI: `caitlyn update [--check] [--yes]`. */
export async function runUpdateCommand(args: string[]): Promise<void> {
  const checkOnly = args.includes("--check");
  const autoYes = args.includes("--yes") || args.includes("-y");

  const status = await checkForUpdate();
  console.log(`Current version: ${status.current}`);
  if (status.error === "offline") {
    console.log("Offline mode (CAITLYN_OFFLINE=1); skipped update check.");
    process.exit(0);
  }
  if (status.error === "check-disabled") {
    console.log("Update checks disabled in ~/.caitlyn/settings.toml ([update] check = false).");
    process.exit(0);
  }
  if (!status.latest) {
    console.log("Could not fetch the latest GitHub release.");
    process.exit(1);
  }
  console.log(`Latest release:  ${status.latest}`);
  if (status.releaseUrl) console.log(`Release notes:   ${status.releaseUrl}`);

  if (!status.updateAvailable) {
    console.log("Already up to date.");
    process.exit(0);
  }

  if (checkOnly) {
    console.log("Update available. Run: caitlyn update");
    process.exit(0);
  }

  let proceed = autoYes;
  if (!proceed) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Install ${loadSyncSettings().npmPackage}@${status.latest} via npm -g? [y/N]: `, (a) => {
        rl.close();
        resolve(a.trim().toLowerCase());
      });
    });
    proceed = answer === "y" || answer === "yes";
  }
  if (!proceed) {
    console.log("Cancelled.");
    process.exit(0);
  }

  console.log("Applying npm update...");
  const applied = applyNpmUpdate(status.latest);
  if (applied.ok) {
    console.log(`✅ Updated via: ${applied.command}`);
    process.exit(0);
  }
  console.error(`❌ npm update failed.\nTried: ${applied.command}\n${applied.detail}`);
  console.error(
    "If you run from a git checkout, pull the matching release tag instead of using npm -g.",
  );
  process.exit(1);
}
