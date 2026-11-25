/**
 * Tests for the persisted privacy surrogate vault.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrivacyVault } from "../../src/privacy/vault.js";

describe("PrivacyVault persistence", () => {
  it("sees mappings written by another vault process after first loading", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-vault-"));
    const writer = PrivacyVault.open(dir);
    const reader = PrivacyVault.open(dir);
    const surrogate = "<PASSWORD_deadbeef>";

    expect(reader.lookup(surrogate)).toBeUndefined();
    writer.remember(surrogate, "fixture-secret");

    expect(reader.lookup(surrogate)).toBe("fixture-secret");
    expect(reader.surrogates()).toContain(surrogate);
  });
});
