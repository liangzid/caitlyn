/**
 * Tests for TUI command handlers: /antibody add/remove and /login.
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
  doAntibodyAddFull,
  doAntibodyRemove,
  doLogin,
} from "../src/commands/handlers.js";
import { loadAntibodies } from "../src/library.js";
import { persistApiKey } from "../src/config/credentials.js";

function makeHost() {
  return {
    showSystemMessage: vi.fn(),
    refreshFooter: vi.fn(),
  } as never;
}

describe("antibody management handlers", () => {
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

  it("creates a tier-0 antibody with config, readme and detect script", async () => {
    await doAntibodyAddFull(host, "ab-new-test", "injection", 0);
    const dir = path.join(tmpDir, "antibodies", "ab-new-test");
    expect(fs.existsSync(path.join(dir, "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "detect.ts"))).toBe(true);

    const loaded = loadAntibodies();
    expect(loaded.map((a) => a.config.id)).toContain("ab-new-test");
    expect(host.showSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Antibody "ab-new-test" created'),
    );
  });

  it("creates a tier-1 antibody without a detect script", async () => {
    await doAntibodyAddFull(host, "ab-tier1", "jailbreak", 1);
    expect(fs.existsSync(path.join(tmpDir, "antibodies", "ab-tier1", "detect.ts"))).toBe(false);
  });

  it("rejects invalid ids, categories and tiers", async () => {
    await doAntibodyAddFull(host, "Bad Id!", "injection", 0);
    await doAntibodyAddFull(host, "ab-x", "nonsense", 0);
    await doAntibodyAddFull(host, "ab-x", "injection", 9);
    expect(fs.existsSync(path.join(tmpDir, "antibodies", "Bad Id!"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "antibodies", "ab-x"))).toBe(false);
    expect(host.showSystemMessage).toHaveBeenCalledTimes(3);
  });

  it("refuses to duplicate an existing id", async () => {
    await doAntibodyAddFull(host, "ab-dup", "injection", 0);
    await doAntibodyAddFull(host, "ab-dup", "injection", 0);
    expect(host.showSystemMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("already exists"),
    );
  });

  it("moves removed antibodies to .trash and hides them from the library", async () => {
    await doAntibodyAddFull(host, "ab-gone", "injection", 0);
    await doAntibodyRemove(host, "ab-gone");

    expect(fs.existsSync(path.join(tmpDir, "antibodies", "ab-gone"))).toBe(false);
    const trashItems = fs.readdirSync(path.join(tmpDir, "antibodies", ".trash"));
    expect(trashItems.some((f) => f.startsWith("ab-gone-"))).toBe(true);
    expect(loadAntibodies().map((a) => a.config.id)).not.toContain("ab-gone");
  });

  it("reports missing antibodies on remove", async () => {
    await doAntibodyRemove(host, "ab-missing");
    expect(host.showSystemMessage).toHaveBeenCalledWith(
      'Antibody "ab-missing" not found.',
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
