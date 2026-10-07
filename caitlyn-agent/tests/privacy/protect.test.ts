/**
 * Tests for the local privacy boundary: format-preserving tokens,
 * secret placeholders, metric noise, and vault restore.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { protectOutbound, restoreInbound } from "../../src/privacy/protect.js";
import { PrivacyVault } from "../../src/privacy/vault.js";

const KEY = Buffer.from("caitlyn-privacy-test-key-32bytes!");

function vault(random?: () => number): PrivacyVault {
  return PrivacyVault.memory(KEY, random);
}

describe("protectOutbound", () => {
  it("replaces an API key with a stable placeholder and restores it", () => {
    const store = vault();
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const text = `OPENAI_API_KEY=${secret}`;
    const first = protectOutbound(text, store);
    const second = protectOutbound(text, store);
    expect(first.text).not.toContain(secret);
    expect(first.text).toContain("<OPENAI_KEY_");
    expect(second.text).toBe(first.text);
    expect(restoreInbound(first.text, store).text).toBe(text);
  });

  it("keeps email format and round-trips through the vault", () => {
    const store = vault();
    const original = "Reach ada@example.com today";
    const protectedText = protectOutbound(original, store);
    expect(protectedText.text).not.toContain("ada@example.com");
    expect(protectedText.text).toMatch(/Reach \S+@\S+\.com today/);
    expect(restoreInbound(protectedText.text, store).text).toBe(original);
  });

  it("preserves credit-card separators and refuses a non-Luhn digit group", () => {
    const store = vault();
    const card = "4111-1111-1111-1111";
    const protectedCard = protectOutbound(`card ${card}`, store);
    expect(protectedCard.text).not.toContain(card);
    expect(protectedCard.text).toMatch(/card \d{4}-\d{4}-\d{4}-\d{4}/);
    expect(protectOutbound("id 1234-5678-9012-3456", store).changed).toBe(false);
  });

  it("perturbs a labeled age and does not restore the original number", () => {
    const store = vault(() => 0.2);
    const protectedAge = protectOutbound("age: 40", store, "strict");
    expect(protectedAge.text).toMatch(/^age: \d+$/);
    expect(protectedAge.text).not.toBe("age: 40");
    expect(restoreInbound(protectedAge.text, store).text).toBe(protectedAge.text);
  });

  it("leaves labeled ages unchanged at the standard level", () => {
    const store = vault(() => 0.2);
    expect(protectOutbound("age: 40", store, "standard").changed).toBe(false);
  });

  it("does nothing when the level is off", () => {
    const store = vault();
    const text = "mail ada@example.com key sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    expect(protectOutbound(text, store, "off")).toEqual({ text, changed: false, count: 0 });
  });

  it("leaves ordinary prose unchanged", () => {
    const store = vault();
    const text = "The temperature is 72 degrees.";
    expect(protectOutbound(text, store)).toEqual({ text, changed: false, count: 0 });
  });

  it("round-trips a sealed map on disk without writing the original in cleartext", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-privacy-"));
    const disk = PrivacyVault.open(root);
    const secret = "ghp_" + "a".repeat(36);
    const protectedText = protectOutbound(`token ${secret}`, disk);
    const map = fs.readFileSync(path.join(root, "privacy-map.json"), "utf-8");
    expect(map).not.toContain(secret);
    const reopened = PrivacyVault.open(root);
    expect(restoreInbound(protectedText.text, reopened).text).toBe(`token ${secret}`);
  });
});
