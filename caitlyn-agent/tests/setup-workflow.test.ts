/**
 * CAITLYN guided setup workflow tests.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_REGISTRY } from "../src/adapters/registry.js";
import { loadConfigFile, loadScanningConfig } from "../src/config.js";
import {
  customizeDetection,
  presetDocument,
  runSetupWizard,
} from "../src/setup/workflow.js";
import type { SetupChoice, SetupPrompts } from "../src/setup/types.js";

/** Deterministic prompt driver that also records all user-visible output. */
class ScriptedPrompts implements SetupPrompts {
  readonly messages: string[] = [];

  constructor(
    private readonly selections: string[],
    private readonly confirmations: boolean[],
    private readonly inputs: string[] = [],
    private readonly secrets: string[] = [],
    private readonly multiSelections: string[][] = [],
  ) {}

  heading(title: string): void { this.messages.push(title); }
  info(message: string): void { this.messages.push(message); }
  warn(message: string): void { this.messages.push(message); }
  success(message: string): void { this.messages.push(message); }
  close(): void {}

  /** Return the next selected value and prove the workflow offered it. */
  async select<T extends string>(
    _message: string,
    choices: SetupChoice<T>[],
    _defaultValue?: T,
  ): Promise<T> {
    const answer = this.selections.shift();
    if (answer === undefined) throw new Error("No scripted selection remains");
    if (!choices.some((choice) => choice.value === answer)) {
      throw new Error(`Selection ${answer} was not offered`);
    }
    return answer as T;
  }

  /** Return the next multi-selection and prove every value was offered. */
  async multiSelect<T extends string>(
    _message: string,
    choices: SetupChoice<T>[],
    _defaultValues?: T[],
  ): Promise<T[]> {
    const answer = this.multiSelections.shift() ?? [];
    for (const value of answer) {
      if (!choices.some((choice) => choice.value === value)) {
        throw new Error(`Multi-selection ${value} was not offered`);
      }
    }
    return answer as T[];
  }

  /** Return the next scripted text input. */
  async input(_message: string, defaultValue?: string): Promise<string> {
    return this.inputs.shift() ?? defaultValue ?? "";
  }

  /** Return the next secret without adding it to recorded output. */
  async secret(_message: string): Promise<string> {
    const answer = this.secrets.shift();
    if (answer === undefined) throw new Error("No scripted secret remains");
    return answer;
  }

  /** Return the next scripted confirmation. */
  async confirm(_message: string, _defaultValue: boolean): Promise<boolean> {
    const answer = this.confirmations.shift();
    if (answer === undefined) throw new Error("No scripted confirmation remains");
    return answer;
  }
}

describe("runSetupWizard", () => {
  it("validates and persists a new provider key only after final confirmation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-flow-"));
    const configPath = path.join(dir, "config.toml");
    const secret = "private-test-key-value";
    const saved: Array<[string, string]> = [];
    const prompts = new ScriptedPrompts(
      ["deepseek", "deepseek-v4-flash", "balanced"],
      [true, false, true],
      [],
      [secret],
    );

    const result = await runSetupWizard(prompts, { configPath }, {
      authStatus: () => ({ runtime: false, persisted: false, env: false }),
      providerEnvVars: () => ["DEEPSEEK_API_KEY"],
      verify: async (config, key) => {
        expect(config).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash" });
        expect(key).toBe(secret);
        return "OK";
      },
      saveApiKey: (provider, key) => saved.push([provider, key]),
      detectAgents: () => [],
    });

    expect(result.connectionVerified).toBe(true);
    expect(saved).toEqual([["deepseek", secret]]);
    expect(loadConfigFile(configPath)).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(loadScanningConfig(configPath).skipTier1).toBe(false);
    expect(prompts.messages.join("\n")).not.toContain(secret);
  });

  it("previews and installs selected detected Agents", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-agent-"));
    const configPath = path.join(dir, "config.toml");
    const codex = AGENT_REGISTRY.find((agent) => agent.id === "codex")!;
    const installCalls: Array<{ id: string; dryRun: boolean }> = [];
    const prompts = new ScriptedPrompts(
      ["deepseek", "deepseek-v4-flash", "local"],
      [true, false, false, true],
      [],
      [],
      [["codex"]],
    );

    const result = await runSetupWizard(prompts, { configPath }, {
      authStatus: () => ({ runtime: false, persisted: false, env: true }),
      detectAgents: () => [{
        agent: codex,
        installed: true,
        foundPaths: ["/opt/bin/codex"],
        installPath: "/tmp/codex/hooks.json",
      }],
      hookInstalled: () => false,
      installAgent: (id, dryRun) => {
        installCalls.push({ id, dryRun });
        return {
          agent: codex,
          success: true,
          message: dryRun ? "would install Codex hooks" : "installed Codex hooks",
          filesCreated: dryRun ? ["/tmp/codex/hooks.json"] : [],
          filesModified: [],
          dryRun,
        };
      },
    });

    expect(installCalls).toEqual([
      { id: "codex", dryRun: true },
      { id: "codex", dryRun: false },
    ]);
    expect(result.installedAgents).toEqual(["codex"]);
    expect(prompts.messages.join("\n")).toContain("Bash hooks");
  });

  it("does not write configuration when final confirmation is declined", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-cancel-"));
    const configPath = path.join(dir, "config.toml");
    const prompts = new ScriptedPrompts(
      ["deepseek", "deepseek-v4-flash", "local"],
      [true, false, false, false],
    );

    await expect(runSetupWizard(prompts, { configPath }, {
      authStatus: () => ({ runtime: false, persisted: false, env: true }),
      detectAgents: () => [],
    })).rejects.toThrow("not applied");
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("customizeDetection", () => {
  it("captures detailed tier, timeout, trust, and enforcement choices", async () => {
    const document = presetDocument("balanced", {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      smallModel: "deepseek-v4-flash",
    });
    const prompts = new ScriptedPrompts(
      ["merged", "detectors", "low", "block", "block", "block"],
      [false, true, true, true, true, false],
      ["0.75", "22000", "3", "131072", "45000"],
    );

    const customized = await customizeDetection(prompts, document);

    expect(customized.scanning).toMatchObject({
      skipTier0: true,
      skipTier1: false,
      tier1Mode: "merged",
      mergedScope: "detectors",
      sourceTrust: "low",
      highRisk: true,
      weakSignalThreshold: 0.75,
      tier1TimeoutMs: 22000,
      maxParallelTier1: 3,
    });
    expect(customized.guard).toMatchObject({
      enabled: true,
      beforeEnabled: true,
      afterEnabled: false,
      maxScanBytes: 131072,
      hookTimeoutMs: 45000,
      onError: "block",
      suspiciousAction: "block",
      maliciousAction: "block",
    });
  });
});
