#!/usr/bin/env node
/**
 * CAITLYN — Smoke-test the npm artifact from outside the repository.
 *
 * This test packs the project, installs the tarball into a temporary project,
 * and verifies the CLI, hook binary, public API, and bundled defense library.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/** Run a subprocess and return stdout, failing with its captured diagnostics. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf-8",
    input: options.input,
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

/** Extract npm's final JSON array even when lifecycle scripts print first. */
function parsePackResult(output) {
  const finalArrayStart = output.lastIndexOf("\n[");
  const jsonText = finalArrayStart >= 0 ? output.slice(finalArrayStart + 1) : output;
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack did not return exactly one artifact");
  }
  return parsed[0];
}

/** Verify that the artifact contains runtime resources and excludes dev state. */
function verifyPackageContents(packResult) {
  const paths = new Set(packResult.files.map((file) => file.path));
  const requiredPaths = [
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/hook-bin.js",
    "dist/index.js",
    "antibodies/index.json",
  ];
  for (const requiredPath of requiredPaths) {
    if (!paths.has(requiredPath)) {
      throw new Error(`npm artifact is missing ${requiredPath}`);
    }
  }
  const forbiddenPrefixes = ["src/", "tests/", "extension/__pycache__/"];
  const forbiddenFiles = ["scan_history.json"];
  for (const filePath of paths) {
    if (
      forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix)) ||
      forbiddenFiles.includes(filePath)
    ) {
      throw new Error(`npm artifact contains development state: ${filePath}`);
    }
  }
  const antibodyCount = [...paths].filter((filePath) =>
    /^antibodies\/[^/]+\/config\.yaml$/.test(filePath),
  ).length;
  const antigenCount = [...paths].filter((filePath) =>
    /^antigens\/[^/]+\/config\.yaml$/.test(filePath),
  ).length;
  if (antibodyCount === 0 || antigenCount === 0) {
    throw new Error("npm artifact contains an empty defense library");
  }
  return { antibodyCount, antigenCount };
}

/** Exercise the installed CLI, hook adapter, and package exports. */
function verifyInstalledPackage(installRoot, statsDirectory, expectedCounts) {
  const installedRoot = path.join(installRoot, "node_modules", "caitlyn");
  const cliOutput = run(process.execPath, [path.join(installedRoot, "dist", "cli.js"), "status"], {
    cwd: installRoot,
  });
  if (
    !cliOutput.includes(`${expectedCounts.antibodyCount} antibodies`) ||
    !cliOutput.includes(`${expectedCounts.antigenCount} antigens`)
  ) {
    throw new Error(`Installed CLI did not load the bundled library:\n${cliOutput}`);
  }

  const isolatedHome = path.join(path.dirname(statsDirectory), "home");
  fs.mkdirSync(isolatedHome, { recursive: true });
  const hookOutput = run(
    process.execPath,
    [path.join(installedRoot, "dist", "hook-bin.js")],
    {
      cwd: installRoot,
      input: JSON.stringify({ tool: "read_file", content: "ordinary project notes" }),
      env: {
        PATH: process.env.PATH,
        HOME: isolatedHome,
        CAITLYN_HOME: isolatedHome,
        CAITLYN_STATS_DIR: statsDirectory,
      },
    },
  );
  const hookDecision = JSON.parse(hookOutput);
  if (hookDecision.action !== "allow") {
    throw new Error(`Installed hook rejected benign smoke input: ${hookOutput}`);
  }

  const sdkOutput = run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { loadAntibodies, loadAntigens } from 'caitlyn'; " +
        "console.log(JSON.stringify([loadAntibodies().length, loadAntigens().length]));",
    ],
    { cwd: installRoot },
  );
  const [antibodyCount, antigenCount] = JSON.parse(sdkOutput);
  if (
    antibodyCount !== expectedCounts.antibodyCount ||
    antigenCount !== expectedCounts.antigenCount
  ) {
    throw new Error(`Installed SDK loaded ${antibodyCount}/${antigenCount} library entries`);
  }
}

/** Build, inspect, install, and execute one npm tarball. */
function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-package-test-"));
  try {
    const packOutput = run(npmCommand, [
      "pack",
      "--json",
      "--pack-destination",
      temporaryRoot,
    ]);
    const packResult = parsePackResult(packOutput);
    const expectedCounts = verifyPackageContents(packResult);

    const archivePath = path.join(temporaryRoot, packResult.filename);
    const installRoot = path.join(temporaryRoot, "install");
    fs.mkdirSync(installRoot, { recursive: true });
    run(npmCommand, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      archivePath,
    ]);
    verifyInstalledPackage(
      installRoot,
      path.join(temporaryRoot, "stats"),
      expectedCounts,
    );
    console.log(
      `npm package smoke test passed (${packResult.size} bytes, ${packResult.files.length} files)`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main();
