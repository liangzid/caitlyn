/**
 * Tests for TUI command handlers: /defense-skill add/remove and /login.
 * The library dir is redirected per-test via CAITLYN_LIBRARY_DIR, which
 * library.ts resolves at call time (no module reload races).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../src/config/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/credentials.js")>();
  return {
    ...actual,
    persistApiKey: vi.fn(),
    listConfiguredProviders: vi.fn(() => []),
  };
});

import {
  doDefenseSkillAddFull,
  doDefenseSkillRemove,
  doLogin,
} from "../src/commands/handlers.js";
import { loadDefenseSkills } from "../src/library.js";
import { persistApiKey } from "../src/config/credentials.js";

function makeHost() {
  return {
    showSystemMessage: vi.fn(),
    refreshFooter: vi.fn(),
  } as never;
}

describe("defense-skill management handlers", () => {
  let tmpDir: string;
  let previousLibraryDir: string | undefined;
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    previousLibraryDir = process.env.CAITLYN_LIBRARY_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-handlers-"));
    process.env.CAITLYN_LIBRARY_DIR = tmpDir;
    host = makeHost();
  });

  afterEach(() => {
    if (previousLibraryDir) {
      process.env.CAITLYN_LIBRARY_DIR = previousLibraryDir;
    } else {
      delete process.env.CAITLYN_LIBRARY_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a tier-0 defense skill with config, readme and detect script", async () => {
    await doDefenseSkillAddFull(host, "new-test", "injection", 0);
    const dir = path.join(tmpDir, "skills", "new-test");
    expect(fs.existsSync(path.join(dir, "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "detect.ts"))).toBe(true);

    const loaded = loadDefenseSkills();
    expect(loaded.map((a) => a.config.id)).toContain("new-test");
    expect(host.showSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Defense skill "new-test" created'),
    );
  });

  it("creates a tier-1 defense skill without a detect script", async () => {
    await doDefenseSkillAddFull(host, "tier1", "jailbreak", 1);
    expect(fs.existsSync(path.join(tmpDir, "skills", "tier1", "detect.ts"))).toBe(false);
  });

  it("rejects invalid ids, categories and tiers", async () => {
    await doDefenseSkillAddFull(host, "Bad Id!", "injection", 0);
    await doDefenseSkillAddFull(host, "x", "nonsense", 0);
    await doDefenseSkillAddFull(host, "x", "injection", 9);
    expect(fs.existsSync(path.join(tmpDir, "skills", "Bad Id!"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "skills", "x"))).toBe(false);
    expect(host.showSystemMessage).toHaveBeenCalledTimes(3);
  });

  it("refuses to duplicate an existing id", async () => {
    await doDefenseSkillAddFull(host, "dup", "injection", 0);
    await doDefenseSkillAddFull(host, "dup", "injection", 0);
    expect(host.showSystemMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("already exists"),
    );
  });

  it("moves removed defense skills to .trash and hides them from the library", async () => {
    await doDefenseSkillAddFull(host, "gone", "injection", 0);
    await doDefenseSkillRemove(host, "gone");

    expect(fs.existsSync(path.join(tmpDir, "skills", "gone"))).toBe(false);
    const trashItems = fs.readdirSync(path.join(tmpDir, "skills", ".trash"));
    expect(trashItems.some((f) => f.startsWith("gone-"))).toBe(true);
    expect(loadDefenseSkills().map((a) => a.config.id)).not.toContain("gone");
  });

  it("reports missing defense skills on remove", async () => {
    await doDefenseSkillRemove(host, "missing");
    expect(host.showSystemMessage).toHaveBeenCalledWith(
      'Defense skill "missing" not found.',
    );
  });
});

describe("login handler", () => {
  beforeEach(() => {
    vi.mocked(persistApiKey).mockClear();
  });

  it("persists the api key when provider and key are given", async () => {
    const host = makeHost();
    await doLogin(host, "deepseek sk-abc123");
    expect(persistApiKey).toHaveBeenCalledWith("deepseek", "sk-abc123");
    expect(host.showSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining("API key saved for deepseek"),
    );
  });

  it("shows usage when the key is missing", async () => {
    const host = makeHost();
    await doLogin(host, "deepseek");
    expect(persistApiKey).not.toHaveBeenCalled();
    expect(host.showSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /login"),
    );
  });
});
