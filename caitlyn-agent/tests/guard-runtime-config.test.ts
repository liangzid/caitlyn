/**
 * CAITLYN Agent hook runtime configuration tests.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GUARD_RUNTIME_DEFAULTS,
  loadGuardRuntimeConfig,
} from "../src/config.js";

/** Write a temporary TOML file for guard configuration tests. */
function writeGuardConfig(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-guard-cfg-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, ["[guard]", ...lines, ""].join("\n"), "utf-8");
  return file;
}

describe("loadGuardRuntimeConfig", () => {
  it("returns stable defaults for a missing file", () => {
    expect(loadGuardRuntimeConfig("/nonexistent/caitlyn/config.toml"))
      .toEqual(GUARD_RUNTIME_DEFAULTS);
  });

  it("loads hook coverage, limits, failure behavior, and verdict policy", () => {
    const file = writeGuardConfig([
      "enabled = true",
      "before_enabled = false",
      "after_enabled = true",
      "hook_timeout_ms = 25000",
      "max_scan_bytes = 131072",
      'on_error = "block"',
      'suspicious_action = "block"',
      'malicious_action = "flag"',
    ]);

    expect(loadGuardRuntimeConfig(file)).toEqual({
      enabled: true,
      beforeEnabled: false,
      afterEnabled: true,
      hookTimeoutMs: 25000,
      maxScanBytes: 131072,
      onError: "block",
      suspiciousAction: "block",
      maliciousAction: "flag",
    });
  });

  it("rejects invalid actions and non-positive limits", () => {
    const file = writeGuardConfig([
      "hook_timeout_ms = 0",
      "max_scan_bytes = -1",
      'on_error = "retry"',
      'suspicious_action = "delete"',
    ]);
    expect(loadGuardRuntimeConfig(file)).toEqual(GUARD_RUNTIME_DEFAULTS);
  });
});
