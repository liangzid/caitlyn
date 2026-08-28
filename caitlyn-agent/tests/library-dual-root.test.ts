/**
 * Tests for dual-root library merge and copy-on-write save.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  invalidateLibraryCache,
  loadAntibodies,
  saveAntibody,
  shippedAntibodiesDir,
  antibodiesDir,
  isShippedLibraryPath,
} from "../src/library.js";
import type { AntibodyEntry } from "../src/schema.js";

function writeMinimalAntibody(root: string, id: string, name: string): void {
  const dir = path.join(root, "antibodies", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    [
      `id: "${id}"`,
      `name: "${name}"`,
      `parent_id: null`,
      `category: "injection"`,
      `tier: 1`,
      `threshold: 0.5`,
      `description: "test"`,
      `prompt: "detect injection"`,
      `role: "detector"`,
      `affinity_score: 0`,
      `created_at: "2026-01-01"`,
      `generation: 0`,
      `stats:`,
      `  total_scans: 0`,
      `  true_positives: 0`,
      `  false_positives: 0`,
      `  avg_latency_us: 0`,
      `deps: []`,
      `signatures: []`,
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "README.md"), `# ${id}\n`, "utf-8");
}

describe("dual-root library", () => {
  let shipped: string;
  let user: string;
  let prevLib: string | undefined;
  let prevUser: string | undefined;

  beforeEach(() => {
    shipped = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-shipped-"));
    user = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-user-"));
    prevLib = process.env.CAITLYN_LIBRARY_DIR;
    prevUser = process.env.CAITLYN_USER_LIBRARY_DIR;
    // Dual-root: LIBRARY_DIR = shipped, USER_LIBRARY_DIR = user (different paths).
    process.env.CAITLYN_LIBRARY_DIR = shipped;
    process.env.CAITLYN_USER_LIBRARY_DIR = user;
  });

  afterEach(() => {
    invalidateLibraryCache();
    if (prevLib === undefined) delete process.env.CAITLYN_LIBRARY_DIR;
    else process.env.CAITLYN_LIBRARY_DIR = prevLib;
    if (prevUser === undefined) delete process.env.CAITLYN_USER_LIBRARY_DIR;
    else process.env.CAITLYN_USER_LIBRARY_DIR = prevUser;
    fs.rmSync(shipped, { recursive: true, force: true });
    fs.rmSync(user, { recursive: true, force: true });
  });

  it("user overrides shipped by id when dual-root envs are set", () => {
    writeMinimalAntibody(shipped, "ab-shared", "shipped-name");
    writeMinimalAntibody(user, "ab-shared", "user-name");
    writeMinimalAntibody(shipped, "ab-only-shipped", "shipped-only");
    writeMinimalAntibody(user, "ab-only-user", "user-only");
    invalidateLibraryCache();

    const loaded = loadAntibodies();
    const byId = new Map(loaded.map((a) => [a.config.id, a]));
    expect(byId.get("ab-shared")?.config.name).toBe("user-name");
    expect(byId.has("ab-only-shipped")).toBe(true);
    expect(byId.has("ab-only-user")).toBe(true);
    expect(isShippedLibraryPath(path.join(shipped, "antibodies", "ab-only-shipped"))).toBe(true);
    expect(antibodiesDir()).toBe(path.join(user, "antibodies"));
    expect(shippedAntibodiesDir()).toBe(path.join(shipped, "antibodies"));
  });

  it("saveAntibody copy-on-writes shipped entries into the user root", () => {
    writeMinimalAntibody(shipped, "ab-cow", "shipped");
    invalidateLibraryCache();
    const entry = loadAntibodies().find((a) => a.config.id === "ab-cow") as AntibodyEntry;
    expect(entry).toBeTruthy();
    entry.config.stats.total_scans = 3;
    saveAntibody(entry);
    expect(entry.folderPath.startsWith(user)).toBe(true);
    expect(fs.existsSync(path.join(user, "antibodies", "ab-cow", "config.yaml"))).toBe(true);
    // Shipped original remains.
    expect(fs.existsSync(path.join(shipped, "antibodies", "ab-cow", "config.yaml"))).toBe(true);
  });
});
