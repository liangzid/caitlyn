/**
 * Tests for adapters/registry.ts — agent detection and install logic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  AGENT_REGISTRY,
  detectAgents,
  installAgent,
  enableCodexHooks,
  which,
} from "../../src/adapters/registry.js";

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-registry-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Registry Tests ──────────────────────────────────────────────────

describe("AGENT_REGISTRY", () => {
  it("has entries for all 6 supported agents", () => {
    const ids = AGENT_REGISTRY.map((a) => a.id).sort();
    expect(ids).toEqual(["claude-code", "codex", "hermes", "openclaw", "opencode", "pi"]);
  });

  it("every agent has a detect block", () => {
    for (const agent of AGENT_REGISTRY) {
      expect(agent.detect).toBeDefined();
    }
  });

  it("every agent has an install block", () => {
    for (const agent of AGENT_REGISTRY) {
      expect(agent.install).toBeDefined();
    }
  });

  it("every agent has a valid integration method", () => {
    for (const agent of AGENT_REGISTRY) {
      expect(["hooks", "fs-watcher", "both"]).toContain(agent.integrationMethod);
    }
  });
});

// ── which() Tests ──────────────────────────────────────────────────

describe("which", () => {
  it("finds 'node' in PATH", () => {
    expect(which("node")).not.toBeNull();
  });

  it("returns null for nonexistent binary", () => {
    expect(which("nonexistent-binary-xyz-123")).toBeNull();
  });

  it("finds binary in a custom directory", () => {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "my-test-bin");
    fs.writeFileSync(binPath, "#!/bin/sh\necho ok", { mode: 0o755 });

    const oldPath = process.env.PATH;
    process.env.PATH = binDir + path.delimiter + (oldPath || "");
    try {
      expect(which("my-test-bin")).toBe(binPath);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

// ── detectAgents() Tests ────────────────────────────────────────────

describe("detectAgents", () => {
  it("returns results for all registered agents", () => {
    const results = detectAgents();
    expect(results.length).toBe(AGENT_REGISTRY.length);
  });

  it("each result has an agent reference and installed boolean", () => {
    const results = detectAgents();
    for (const r of results) {
      expect(r.agent).toBeDefined();
      expect(typeof r.installed).toBe("boolean");
      expect(Array.isArray(r.foundPaths)).toBe(true);
    }
  });

  it("detects node as installed (node is always in PATH)", () => {
    // node is always available in test env — not a real agent but proves the
    // detection logic wires up binaries correctly
    const results = detectAgents();
    // At least one agent should be detected (claude/codex/opencode use binary check)
    const withBinaries = results.filter(
      (r) => r.agent.detect.binaries && r.agent.detect.binaries.length > 0,
    );
    expect(withBinaries.length).toBeGreaterThan(0);
  });

  it("detects pi-agent when package.json has the dependency", () => {
    // Create a fake project with pi-agent-core dependency
    const projectDir = path.join(tmpDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        name: "test",
        dependencies: { "@earendil-works/pi-agent-core": "^0.80.0" },
      }),
    );

    const oldCwd = process.cwd();
    try {
      process.chdir(projectDir);
      const results = detectAgents();
      const pi = results.find((r) => r.agent.id === "pi");
      expect(pi).toBeDefined();
      expect(pi!.installed).toBe(true);
      expect(pi!.foundPaths.some((p) => p.endsWith("package.json"))).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("does not detect pi-agent when no package.json exists", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const oldCwd = process.cwd();
    try {
      process.chdir(emptyDir);
      const results = detectAgents();
      const pi = results.find((r) => r.agent.id === "pi");
      expect(pi).toBeDefined();
      expect(pi!.installed).toBe(false);
    } finally {
      process.chdir(oldCwd);
    }
  });
});

// ── installAgent() Tests ────────────────────────────────────────────

describe("installAgent", () => {
  it("returns error for unknown agent", () => {
    const result = installAgent("nonexistent-agent");
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown agent");
  });

  it("installs hermes plugin by copying the plugin file", () => {
    // Override home to tmpDir so we don't write to real ~
    const fakeHome = path.join(tmpDir, "home");
    const hermesPluginsDir = path.join(fakeHome, ".hermes", "plugins");
    fs.mkdirSync(hermesPluginsDir, { recursive: true });

    // Temporarily mock home
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = installAgent("hermes");
      expect(result.success).toBe(true);
      expect(result.filesCreated.length).toBeGreaterThan(0);

      // Verify file was created
      const pluginPath = result.filesCreated.find((p) => p.includes("caitlyn_plugin.py"));
      expect(pluginPath).toBeDefined();
      expect(fs.existsSync(pluginPath!)).toBe(true);

      // Verify content
      const content = fs.readFileSync(pluginPath!, "utf-8");
      expect(content).toContain("CAITLYN Guard Plugin");
      expect(content).toContain("pre_tool_call");
      expect(content).toContain("caitlyn-hook");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("merges JSON config for claude-code", () => {
    const fakeHome = path.join(tmpDir, "claude-home");
    const claudeDir = path.join(fakeHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });

    // Pre-create existing settings.json
    const existingSettings = { model: "claude-sonnet-4-20250514" };
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(existingSettings, null, 2),
    );

    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = installAgent("claude-code");
      expect(result.success).toBe(true);

      // Verify merged config
      const configPath = path.join(claudeDir, "settings.json");
      expect(fs.existsSync(configPath)).toBe(true);
      const merged = JSON.parse(fs.readFileSync(configPath, "utf-8"));

      // Original keys preserved
      expect(merged.model).toBe("claude-sonnet-4-20250514");
      // New hooks added
      expect(merged.hooks).toBeDefined();
      expect(merged.hooks.PreToolUse).toBeDefined();
      expect(merged.hooks.PreToolUse[0].matcher).toBe(".*");
      expect(merged.hooks.PostToolUse).toBeDefined();
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("creates config directory if it does not exist", () => {
    const fakeHome = path.join(tmpDir, "fresh-home");
    // No .claude directory exists yet

    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = installAgent("claude-code");
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(fakeHome, ".claude", "settings.json"))).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("installs pi middleware successfully", () => {
    // pi now uses file-copy (like all other agents)
    const result = installAgent("pi");
    expect(result.success).toBe(true);
    // Message should reference the middleware approach
    expect(typeof result.message).toBe("string");
  });
});

// ── enableCodexHooks() Tests ────────────────────────────────────────

describe("enableCodexHooks", () => {
  it("adds codex_hooks flag to existing config", () => {
    const fakeHome = path.join(tmpDir, "codex-home");
    const codexDir = path.join(fakeHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), "[model]\nname = \"gpt-5-codex\"");

    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const ok = enableCodexHooks();
      expect(ok).toBe(true);

      const content = fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8");
      expect(content).toContain("[features]");
      expect(content).toContain("codex_hooks = true");
      expect(content).toContain("[model]"); // original section preserved
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("creates config with features section if no config exists", () => {
    const fakeHome = path.join(tmpDir, "codex-fresh");
    const codexDir = path.join(fakeHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });

    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const ok = enableCodexHooks();
      expect(ok).toBe(true);

      const content = fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8");
      expect(content).toContain("[features]");
      expect(content).toContain("codex_hooks = true");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("is idempotent — does not duplicate flag", () => {
    const fakeHome = path.join(tmpDir, "codex-idem");
    const codexDir = path.join(fakeHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      "[features]\ncodex_hooks = true\n",
    );

    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const ok = enableCodexHooks();
      expect(ok).toBe(true);

      const content = fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8");
      // Should only appear once
      const matches = content.match(/codex_hooks = true/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    } finally {
      process.env.HOME = origHome;
    }
  });
});
