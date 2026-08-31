/**
 * CAITLYN guided setup terminal prompt tests.
 */

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { TerminalSetupPrompts } from "../src/setup/terminal-prompts.js";
import { SetupCancelledError } from "../src/setup/types.js";
import { runSetupWizard } from "../src/setup/workflow.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfigFile, loadScanningConfig } from "../src/config.js";

/** Feed every answer before the first prompt, then close the pipe. */
function burstInput(lines: string[]): PassThrough {
  const input = new PassThrough();
  input.write(`${lines.join("\n")}\n`);
  input.end();
  return input;
}

describe("TerminalSetupPrompts", () => {
  it("consumes a complete piped answer burst without losing later lines", async () => {
    const input = burstInput(["2", "q"]);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const prompts = new TerminalSetupPrompts(input, output);

    const selected = await prompts.select("Provider", [
      { value: "openrouter", label: "openrouter" },
      { value: "deepseek", label: "deepseek" },
    ]);
    await expect(prompts.confirm("Apply?", true)).rejects.toBeInstanceOf(SetupCancelledError);
    prompts.close();

    expect(selected).toBe("deepseek");
    expect(chunks.join("")).not.toContain("\nq\n");
  });

  it("does not echo secret input into the visible output stream", async () => {
    const secret = "piped-secret-value";
    const input = burstInput([secret]);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const prompts = new TerminalSetupPrompts(input, output);

    const value = await prompts.secret("API key");
    prompts.close();

    expect(value).toBe(secret);
    expect(chunks.join("")).not.toContain(secret);
  });
});

describe("runSetupWizard over a non-TTY pipe", () => {
  it("applies a complete scripted setup without installing Agent hooks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-pipe-"));
    const configPath = path.join(dir, "config.toml");
    const secret = "pipe-only-key";
    const input = burstInput([
      "2",
      "",
      secret,
      "2",
      "n",
      "y",
    ]);
    const output = new PassThrough();
    const visible: string[] = [];
    output.on("data", (chunk) => visible.push(String(chunk)));
    const prompts = new TerminalSetupPrompts(input, output);
    const installCalls: boolean[] = [];
    const saved: Array<[string, string]> = [];

    const result = await runSetupWizard(prompts, {
      configPath,
      skipConnectionTest: true,
    }, {
      authStatus: () => ({ runtime: false, persisted: false, env: false }),
      providerEnvVars: () => ["DEEPSEEK_API_KEY"],
      saveApiKey: (provider, key) => saved.push([provider, key]),
      detectAgents: () => [],
      installAgent: (_id, dryRun) => {
        installCalls.push(dryRun);
        throw new Error("installAgent must not run when no Agents are selected");
      },
    });
    prompts.close();

    expect(result.provider).toBe("deepseek");
    expect(result.detectionPreset).toBe("local");
    expect(result.installedAgents).toEqual([]);
    expect(saved).toEqual([["deepseek", secret]]);
    expect(installCalls).toEqual([]);
    expect(loadConfigFile(configPath).provider).toBe("deepseek");
    expect(loadScanningConfig(configPath).skipTier1).toBe(true);
    expect(visible.join("")).not.toContain(secret);
  });
});
