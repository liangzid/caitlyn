/**
 * CAITLYN configuration path precedence tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findConfigUpward, getUserConfigPath, loadConfig } from "../src/config.js";

const originalCwd = process.cwd();
const originalConfig = process.env.CAITLYN_CONFIG;
const originalHome = process.env.CAITLYN_HOME;

/** Restore process-wide configuration modified by each test. */
afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfig === undefined) delete process.env.CAITLYN_CONFIG;
  else process.env.CAITLYN_CONFIG = originalConfig;
  if (originalHome === undefined) delete process.env.CAITLYN_HOME;
  else process.env.CAITLYN_HOME = originalHome;
});

/** Write a minimal LLM configuration for resolution tests. */
function writeConfig(filePath: string, provider: string, model: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `[llm]\nprovider = "${provider}"\nmodel = "${model}"\n`,
    "utf-8",
  );
}

describe("configuration path resolution", () => {
  it("uses CAITLYN_CONFIG before project and user configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-config-explicit-"));
    const explicit = path.join(root, "selected.toml");
    process.env.CAITLYN_CONFIG = explicit;

    expect(findConfigUpward()).toBe(explicit);
  });

  it("prefers the nearest project configuration over user configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-config-project-"));
    const project = path.join(root, "project");
    const child = path.join(project, "nested");
    const caitlynHome = path.join(root, "home");
    fs.mkdirSync(child, { recursive: true });
    writeConfig(path.join(project, "config.toml"), "openai", "project-model");
    writeConfig(path.join(caitlynHome, "config.toml"), "deepseek", "user-model");
    delete process.env.CAITLYN_CONFIG;
    process.env.CAITLYN_HOME = caitlynHome;
    process.chdir(child);

    expect(findConfigUpward()).toBe(path.join(project, "config.toml"));
    expect(loadConfig()).toMatchObject({ provider: "openai", model: "project-model" });
  });

  it("falls back to the user configuration outside a configured project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-config-user-"));
    const work = path.join(root, "work");
    const caitlynHome = path.join(root, "home");
    fs.mkdirSync(work, { recursive: true });
    writeConfig(path.join(caitlynHome, "config.toml"), "deepseek", "user-model");
    delete process.env.CAITLYN_CONFIG;
    process.env.CAITLYN_HOME = caitlynHome;
    process.chdir(work);

    expect(getUserConfigPath()).toBe(path.join(caitlynHome, "config.toml"));
    expect(findConfigUpward()).toBe(path.join(caitlynHome, "config.toml"));
    expect(loadConfig()).toMatchObject({ provider: "deepseek", model: "user-model" });
  });
});
