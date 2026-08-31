/**
 * CAITLYN guided setup TOML merge, backup, and rollback tests.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfigFile,
  loadGuardRuntimeConfig,
  loadScanningConfig,
} from "../src/config.js";
import {
  mergeSetupConfig,
  rollbackSetupConfig,
  writeSetupConfig,
} from "../src/setup/config-writer.js";
import { presetDocument } from "../src/setup/workflow.js";

/** Return a complete balanced document using a real catalog model. */
function balancedDocument() {
  return presetDocument("balanced", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    smallModel: "deepseek-v4-flash",
  });
}

describe("setup configuration merge", () => {
  it("replaces owned sections and preserves unrelated sections and comments", () => {
    const original = [
      "# operator note",
      "[llm]",
      'provider = "openai"',
      'model = "gpt-4.1"',
      "",
      "[evolution]",
      'autonomy = "candidate"',
      "",
      "[guard]",
      "enabled = false",
      "",
    ].join("\n");
    const merged = mergeSetupConfig(original, balancedDocument());

    expect(merged).toContain("# operator note");
    expect(merged).toContain("[evolution]\nautonomy = \"candidate\"");
    expect(merged.match(/\[llm\]/g)).toHaveLength(1);
    expect(merged.match(/\[guard\]/g)).toHaveLength(1);
    expect(merged).toContain('provider = "deepseek"');
    expect(merged).toContain('tier1_mode = "ensemble"');
  });

  it("round-trips every setup field through the production config readers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-config-"));
    const configPath = path.join(dir, "config.toml");
    const document = balancedDocument();
    document.scanning.tier1Mode = "merged";
    document.scanning.mergedScope = "detectors";
    document.scanning.tier0TimeoutMs = 900;
    document.guard.onError = "block";
    document.guard.maxScanBytes = 123456;

    const result = writeSetupConfig(configPath, document);

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(loadConfigFile(configPath)).toEqual(document.llm);
    expect(loadScanningConfig(configPath)).toEqual(document.scanning);
    expect(loadGuardRuntimeConfig(configPath)).toEqual(document.guard);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("creates a backup and can roll back a failed setup write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-rollback-"));
    const configPath = path.join(dir, "config.toml");
    const original = "# preserved\n[custom]\nvalue = 7\n";
    fs.writeFileSync(configPath, original, "utf-8");

    const result = writeSetupConfig(configPath, balancedDocument());
    expect(result.backupPath).not.toBeNull();
    expect(fs.readFileSync(result.backupPath!, "utf-8")).toBe(original);

    rollbackSetupConfig(result);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("does not rewrite or back up an already identical configuration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-setup-idempotent-"));
    const configPath = path.join(dir, "config.toml");
    const document = balancedDocument();
    const first = writeSetupConfig(configPath, document);
    const second = writeSetupConfig(configPath, document);

    expect(first.changed).toBe(true);
    expect(second).toEqual({ configPath, changed: false, backupPath: null });
  });
});
