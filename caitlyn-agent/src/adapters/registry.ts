/**
 * CAITLYN Agent Registry
 *
 * Defines detection signatures and install/uninstall logic for each supported agent.
 * Used by `caitlyn detect`, `caitlyn install`, and `caitlyn uninstall` commands.
 *
 * Config modification protocol:
 *   1. Backup: every config mutation first copies <path> → <path>.caitlyn-backup
 *   2. Idempotent merge: detects existing CAITLYN hooks, skips if already present
 *   3. Dry-run: --dry-run flag previews changes without touching files
 *   4. Uninstall: `caitlyn uninstall <agent>` restores from backup
 *   5. TOML merge: line-based append for Codex config.toml (no full parser needed)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ───────────────────────────────────────────────────────────

export interface AgentSignature {
  id: string;
  name: string;
  description: string;
  integrationMethod: "hooks" | "fs-watcher" | "both";
  detect: AgentDetection;
  install: AgentInstall;
}

export interface AgentDetection {
  binaries?: string[];
  configPaths?: string[];
  dirPaths?: string[];
  npmDependency?: string;
}

export interface AgentInstall {
  configPath: string;
  mergeStrategy: "merge-json" | "merge-toml" | "copy-file" | "print-instructions";
  content?: string;
  jsonPatch?: Record<string, unknown>;
  /** For idempotency check: a sentinel value that, if present in the config, means hooks are already installed. */
  idempotencyCheck?: { jsonPath: string; matchValue: unknown };
  tomlPatch?: { section: string; lines: string[] };
  additionalFiles?: Array<{ relPath: string; content: string }>;
  postInstallMessage?: string;
  /** Files to remove during uninstall (relative to config). */
  uninstallFiles?: string[];
}

export interface DetectResult {
  agent: AgentSignature;
  installed: boolean;
  foundPaths: string[];
  installPath: string;
}

export interface InstallResult {
  agent: AgentSignature;
  success: boolean;
  message: string;
  filesCreated: string[];
  filesModified: string[];
  dryRun: boolean;
}

export interface UninstallResult {
  agent: AgentSignature;
  success: boolean;
  message: string;
  filesRestored: string[];
  filesRemoved: string[];
  dryRun: boolean;
}

export interface DryRunChange {
  filePath: string;
  action: "create" | "modify" | "delete" | "restore";
  description: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function home(): string {
  return os.homedir();
}

function expandPath(p: string): string {
  if (p.startsWith("~")) return path.join(home(), p.slice(1));
  return p;
}

export function which(binary: string): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const dir of paths) {
    const full = path.join(dir, binary);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* not here */
    }
  }
  return null;
}

function findFirst(paths: string[]): string[] {
  const found: string[] = [];
  for (const p of paths) {
    const expanded = expandPath(p);
    try {
      fs.accessSync(expanded);
      found.push(expanded);
    } catch {
      /* doesn't exist */
    }
  }
  return found;
}

function backupPath(p: string): string {
  return p + ".caitlyn-backup";
}

/**
 * Read a plugin source file bundled with caitlyn.
 * At runtime (dist/), plugins are at dist/plugins/.
 */
function readPluginSource(filename: string): string | null {
  // At runtime (dist/), plugins are at dist/plugins/
  // In dev (src/), they're at src/plugins/
  const candidates = [
    path.join(import.meta.dirname, "plugins", filename),
    path.join(import.meta.dirname, "..", "plugins", filename),
    path.join(import.meta.dirname, "..", "src", "plugins", filename),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf-8"); } catch { /* try next */ }
  }
  return null;
}

// ── Plugin Sources (bundled, no disk read needed at install time) ───

const OPENCODE_PLUGIN_SOURCE = `/**
 * CAITLYN OpenCode Plugin
 * Registers tool.execute.before/after hooks. Delegates to caitlyn-hook.
 */
import { spawnSync } from "node:child_process";
function scan(tool, content) {
  try {
    const r = spawnSync("caitlyn-hook", [], { input: JSON.stringify({ tool, content }), timeout: 5000, encoding: "utf-8" });
    if (r.error || r.status === null) return { action: "allow", reason: "hook unavailable" };
    const o = JSON.parse(r.stdout.trim());
    return { action: o.action, reason: o.reason || "scanned by CAITLYN" };
  } catch { return { action: "allow", reason: "scan error" }; }
}
export default function main(api) {
  api.on("tool.execute.before", async (ctx) => {
    const input = (ctx.input || ctx);
    const d = scan(input.tool || "unknown", input.args ? JSON.stringify(input.args) : "");
    if (d.action === "block") throw new Error("[CAITLYN] " + d.reason);
  });
  api.on("tool.execute.after", async (ctx) => {
    const input = (ctx.input || ctx);
    const output = (ctx.output || {});
    const d = scan(input.tool || "unknown", output.output || "");
    if (d.action === "block") output.output = "[CAITLYN BLOCKED] " + d.reason;
    else if (d.action === "flag") output.output = "[CAITLYN FLAGGED] " + (output.output || "");
  });
}`;

const OPENCLAW_PLUGIN_SOURCE = `/**
 * CAITLYN OpenClaw Plugin
 * Registers before_tool_call/after_tool_call hooks. Delegates to caitlyn-hook.
 */
import { spawnSync } from "node:child_process";
function scan(tool, content) {
  try {
    const r = spawnSync("caitlyn-hook", [], { input: JSON.stringify({ tool, content }), timeout: 5000, encoding: "utf-8" });
    if (r.error || r.status === null) return { action: "allow", reason: "hook unavailable" };
    const o = JSON.parse(r.stdout.trim());
    return { action: o.action, reason: o.reason || "scanned by CAITLYN" };
  } catch { return { action: "allow", reason: "scan error" }; }
}
export default function main(api) {
  api.on("before_tool_call", async (ctx) => {
    const d = scan(ctx.tool || "unknown", ctx.args ? JSON.stringify(ctx.args) : "");
    if (d.action === "block") return { action: "deny", reason: "[CAITLYN] " + d.reason };
    return { action: "allow" };
  });
  api.on("after_tool_call", async (ctx) => {
    const content = typeof ctx.result === "string" ? ctx.result : JSON.stringify(ctx.result || "");
    const d = scan(ctx.tool || "unknown", content);
    if (d.action === "block") console.error("[CAITLYN] Blocked tool output from " + ctx.tool + ": " + d.reason);
  });
}`;

// ── Registry ────────────────────────────────────────────────────────

const CAITLYN_HOOK_SENTINEL = "caitlyn-hook";

export const AGENT_REGISTRY: AgentSignature[] = [
  // ── Claude Code ────────────────────────────────────────────────
  {
    id: "claude-code",
    name: "Claude Code (Anthropic)",
    description:
      "Anthropic's CLI coding agent. Uses Claude Agent SDK with PreToolUse/PostToolUse hooks.",
    integrationMethod: "hooks",
    detect: {
      binaries: ["claude"],
      configPaths: ["~/.claude/settings.json", "~/.claude/claude_desktop_config.json"],
      dirPaths: ["~/.claude/"],
    },
    install: {
      configPath: "~/.claude/settings.json",
      mergeStrategy: "merge-json",
      jsonPatch: {
        "hooks.PreToolUse": [
          {
            matcher: ".*",
            hooks: [{ type: "command", command: "caitlyn-hook claude", timeout: 30 }],
          },
        ],
        "hooks.PostToolUse": [
          {
            matcher: ".*",
            hooks: [{ type: "command", command: "caitlyn-hook claude --post", timeout: 30 }],
          },
        ],
      },
      idempotencyCheck: {
        jsonPath: "hooks.PreToolUse",
        matchValue: CAITLYN_HOOK_SENTINEL,
      },
      uninstallFiles: ["~/.claude/settings.json.caitlyn-backup"],
      postInstallMessage:
        "Claude Code hooks installed. PreToolUse and PostToolUse will scan all tool calls.\n" +
        "Run `claude` normally — CAITLYN hooks fire automatically.",
    },
  },

  // ── Codex CLI ──────────────────────────────────────────────────
  {
    id: "codex",
    name: "Codex CLI (OpenAI)",
    description:
      "OpenAI's CLI coding agent. Hooks cover Bash commands only. FS Watcher recommended for file protection.",
    integrationMethod: "both",
    detect: {
      binaries: ["codex"],
      configPaths: ["~/.codex/config.toml"],
      dirPaths: ["~/.codex/"],
    },
    install: {
      configPath: "~/.codex/hooks.json",
      mergeStrategy: "merge-json",
      jsonPatch: {
        hooks: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [{ type: "command", command: "caitlyn-hook codex", timeout: 30 }],
            },
          ],
          PostToolUse: [
            {
              matcher: ".*",
              hooks: [{ type: "command", command: "caitlyn-hook codex --post", timeout: 30 }],
            },
          ],
        },
      },
      idempotencyCheck: {
        jsonPath: "hooks.PreToolUse",
        matchValue: CAITLYN_HOOK_SENTINEL,
      },
      tomlPatch: {
        section: "features",
        lines: ["codex_hooks = true"],
      },
      uninstallFiles: [
        "~/.codex/hooks.json.caitlyn-backup",
        "~/.codex/config.toml.caitlyn-backup",
      ],
      postInstallMessage:
        "Codex hooks installed. NOTE: Codex PreToolUse only intercepts Bash commands.\n" +
        "File operations (Write, Edit, Read) are NOT covered by hooks.\n" +
        "Run `caitlyn watch ~/.codex/` to enable FS Watcher for file protection.",
    },
  },

  // ── OpenCode ───────────────────────────────────────────────────
  {
    id: "opencode",
    name: "OpenCode (SST)",
    description:
      "Open-source CLI coding agent with plugin-based hook system. Full tool coverage via tool.execute.before/after.",
    integrationMethod: "hooks",
    detect: {
      binaries: ["opencode"],
      configPaths: ["~/.config/opencode/opencode.json"],
      dirPaths: ["~/.config/opencode/"],
    },
    install: {
      configPath: "~/.config/opencode/opencode.json",
      mergeStrategy: "merge-json",
      jsonPatch: {
        plugin: ["./.opencode/plugins/caitlyn-plugin.js"],
      },
      idempotencyCheck: {
        jsonPath: "plugin",
        matchValue: "caitlyn-plugin",
      },
      additionalFiles: [
        { relPath: "~/.config/opencode/plugins/caitlyn-plugin.js", content: OPENCODE_PLUGIN_SOURCE },
      ],
      uninstallFiles: [
        "~/.config/opencode/opencode.json.caitlyn-backup",
        "~/.config/opencode/plugins/caitlyn-plugin.js",
      ],
      postInstallMessage:
        "OpenCode CAITLYN plugin installed.\n" +
        "Run `opencode` normally — hooks fire automatically.",
    },
  },

  // ── Hermes Agent ───────────────────────────────────────────────
  {
    id: "hermes",
    name: "Hermes Agent (Nous Research)",
    description:
      "Nous Research's self-improving agent. Plugin hook system with pre_tool_call.",
    integrationMethod: "hooks",
    detect: {
      binaries: ["hermes"],
      dirPaths: ["~/.hermes/"],
    },
    install: {
      configPath: "~/.hermes/plugins/caitlyn_plugin.py",
      mergeStrategy: "copy-file",
      content: `"""
CAITLYN Guard Plugin for Hermes Agent.
Intercepts tool calls via pre_tool_call hook.
Installed by: caitlyn install hermes
"""
import json, subprocess

def register(ctx):
    async def pre_tool_call(tool_name, args, agent_context):
        try:
            input_data = json.dumps({
                "tool": tool_name,
                "args": args if isinstance(args, dict) else {"raw": str(args)},
            })
            result = subprocess.run(
                ["caitlyn-hook"],
                input=input_data, capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                return {"action": "allow"}
            decision = json.loads(result.stdout)
            if decision.get("action") == "block":
                return {"action": "block", "message": decision.get("reason", "blocked by CAITLYN")}
        except Exception:
            pass
        return {"action": "allow"}

    ctx.register_hook("pre_tool_call", pre_tool_call)
`,
      idempotencyCheck: {
        jsonPath: "",
        matchValue: "",
      },
      uninstallFiles: ["~/.hermes/plugins/caitlyn_plugin.py"],
      postInstallMessage:
        "Hermes CAITLYN plugin installed at ~/.hermes/plugins/caitlyn_plugin.py.\n" +
        "Run `hermes` normally — pre_tool_call hook fires automatically.",
    },
  },

  // ── OpenClaw ───────────────────────────────────────────────────
  {
    id: "openclaw",
    name: "OpenClaw",
    description:
      "Claw-style agent with plugin hooks. before_tool_call / after_tool_call via api.on().",
    integrationMethod: "hooks",
    detect: {
      binaries: ["openclaw", "claw"],
      configPaths: ["~/.openclaw/openclaw.json"],
      dirPaths: ["~/.openclaw/"],
    },
    install: {
      configPath: "~/.openclaw/openclaw.json",
      mergeStrategy: "merge-json",
      jsonPatch: {
        "plugins.entries.caitlyn-guard": {
          enabled: true,
          source: "./plugins/caitlyn-plugin.js",
        },
      },
      idempotencyCheck: {
        jsonPath: "plugins.entries.caitlyn-guard",
        matchValue: "caitlyn-plugin",
      },
      additionalFiles: [
        { relPath: "~/.openclaw/plugins/caitlyn-plugin.js", content: OPENCLAW_PLUGIN_SOURCE },
      ],
      uninstallFiles: [
        "~/.openclaw/openclaw.json.caitlyn-backup",
        "~/.openclaw/plugins/caitlyn-plugin.js",
      ],
      postInstallMessage:
        "OpenClaw CAITLYN plugin installed.\n" +
        "Restart the OpenClaw gateway: `openclaw gateway restart`.",
    },
  },

  // ── pi-coding-agent ────────────────────────────────────────────
  {
    id: "pi",
    name: "pi-coding-agent (Earendil Works)",
    description:
      "TypeScript coding agent based on pi-agent-core. Middleware via agent.use().",
    integrationMethod: "hooks",
    detect: {
      npmDependency: "@earendil-works/pi-agent-core",
    },
    install: {
      configPath: "(in your agent source code)",
      mergeStrategy: "print-instructions",
      uninstallFiles: [],
      postInstallMessage:
        "pi-coding-agent uses in-process middleware. Add these lines to your agent setup:\n\n" +
        "  import { AgentHooksEngine, createPiAgentHookAdapter } from 'caitlyn/guard';\n" +
        "  const engine = new AgentHooksEngine(config, llmCall);\n" +
        "  agent.use(createPiAgentHookAdapter(engine).middleware);\n\n" +
        "The hook engine runs Tier 0 + Tier 1 scanning for every tool call.",
    },
  },
];

// ── Detection ───────────────────────────────────────────────────────

export function detectAgents(): DetectResult[] {
  return AGENT_REGISTRY.map((agent) => {
    const foundPaths: string[] = [];
    if (agent.detect.binaries) {
      for (const bin of agent.detect.binaries) {
        const p = which(bin);
        if (p) foundPaths.push(p);
      }
    }
    if (agent.detect.configPaths) {
      foundPaths.push(...findFirst(agent.detect.configPaths));
    }
    if (agent.detect.dirPaths) {
      foundPaths.push(...findFirst(agent.detect.dirPaths));
    }
    if (agent.detect.npmDependency) {
      let dir = process.cwd();
      for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(dir, "package.json");
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps[agent.detect.npmDependency]) {
            foundPaths.push(pkgPath);
            break;
          }
        } catch {
          /* no package.json */
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return {
      agent,
      installed: foundPaths.length > 0,
      foundPaths,
      installPath: expandPath(agent.install.configPath),
    };
  });
}

// ── CAITLYN Hook Presence Check ─────────────────────────────────────

/** Check whether CAITLYN hooks are already installed for a given agent. */
export function isHookInstalled(agentId: string): boolean {
  const agent = AGENT_REGISTRY.find((a) => a.id === agentId);
  if (!agent || !agent.install.idempotencyCheck) return false;

  const { jsonPath, matchValue } = agent.install.idempotencyCheck;
  const configPath = expandPath(agent.install.configPath);

  if (agent.install.mergeStrategy === "copy-file") {
    // Check if the copied file exists
    return fs.existsSync(configPath);
  }

  if (agent.install.mergeStrategy === "merge-json") {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const existing = JSON.parse(raw);
      const value = getNested(existing, jsonPath);
      if (matchValue === "") return value !== undefined;
      if (typeof value === "string") return value.includes(String(matchValue));
      if (Array.isArray(value)) {
        return value.some((v) => JSON.stringify(v).includes(String(matchValue)));
      }
      return JSON.stringify(value).includes(String(matchValue));
    } catch {
      return false;
    }
  }

  return false;
}

// ── Dry-Run ─────────────────────────────────────────────────────────

/** Preview what `caitlyn install <agentId>` would do without modifying files. */
export function dryRunInstall(agentId: string): DryRunChange[] {
  const agent = AGENT_REGISTRY.find((a) => a.id === agentId);
  if (!agent) return [];

  const changes: DryRunChange[] = [];
  const install = agent.install;
  const configPath = expandPath(install.configPath);
  const exists = fs.existsSync(configPath);

  if (install.mergeStrategy === "copy-file") {
    changes.push({
      filePath: configPath,
      action: exists ? "modify" : "create",
      description: exists
        ? `Overwrite ${install.configPath} with CAITLYN plugin`
        : `Create ${install.configPath}`,
    });
  } else if (install.mergeStrategy === "merge-json") {
    changes.push({
      filePath: configPath,
      action: exists ? "modify" : "create",
      description: exists
        ? `Merge CAITLYN hooks into ${install.configPath} (existing keys preserved)`
        : `Create ${install.configPath} with CAITLYN hooks`,
    });
  } else if (install.mergeStrategy === "merge-toml") {
    changes.push({
      filePath: configPath,
      action: "modify",
      description: `Append CAITLYN section to ${install.configPath}`,
    });
  }

  if (install.additionalFiles) {
    for (const f of install.additionalFiles) {
      changes.push({
        filePath: expandPath(f.relPath),
        action: "create",
        description: `Create ${f.relPath}`,
      });
    }
  }

  return changes;
}

/** Preview what `caitlyn uninstall <agentId>` would do. */
export function dryRunUninstall(agentId: string): DryRunChange[] {
  const agent = AGENT_REGISTRY.find((a) => a.id === agentId);
  if (!agent) return [];

  const changes: DryRunChange[] = [];
  const install = agent.install;
  const configPath = expandPath(install.configPath);
  const backup = backupPath(configPath);

  if (fs.existsSync(backup)) {
    changes.push({
      filePath: configPath,
      action: "restore",
      description: `Restore ${install.configPath} from backup`,
    });
  }

  if (install.uninstallFiles) {
    for (const f of install.uninstallFiles) {
      const fp = expandPath(f);
      if (fs.existsSync(fp)) {
        changes.push({
          filePath: fp,
          action: "delete",
          description: `Remove ${f}`,
        });
      }
    }
  }

  return changes;
}

// ── Install ─────────────────────────────────────────────────────────

export function installAgent(agentId: string, dryRun = false): InstallResult {
  const agent = AGENT_REGISTRY.find((a) => a.id === agentId);
  if (!agent) {
    return {
      agent: { id: agentId } as AgentSignature,
      success: false,
      message: `Unknown agent: ${agentId}. Supported: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`,
      filesCreated: [],
      filesModified: [],
      dryRun,
    };
  }

  // Idempotency check
  if (isHookInstalled(agentId)) {
    return {
      agent,
      success: true,
      message: `CAITLYN hooks are already installed for ${agent.name}. Nothing to do.`,
      filesCreated: [],
      filesModified: [],
      dryRun,
    };
  }

  if (dryRun) {
    const changes = dryRunInstall(agentId);
    return {
      agent,
      success: true,
      message: `Dry-run: would make ${changes.length} change(s):\n${changes.map((c) => `  ${c.action} ${c.filePath}`).join("\n")}`,
      filesCreated: [],
      filesModified: [],
      dryRun,
    };
  }

  const install = agent.install;
  const filesCreated: string[] = [];
  const filesModified: string[] = [];

  try {
    switch (install.mergeStrategy) {
      case "merge-json":
        mergeJsonConfig(install.configPath, install.jsonPatch || {});
        filesModified.push(expandPath(install.configPath));
        break;
      case "copy-file":
        copyFileConfig(install.configPath, install.content || "");
        filesCreated.push(expandPath(install.configPath));
        break;
      case "merge-toml":
        mergeTomlConfig(install.configPath, install.tomlPatch);
        filesModified.push(expandPath(install.configPath));
        break;
      case "print-instructions":
        break;
    }

    if (install.additionalFiles) {
      for (const f of install.additionalFiles) {
        const fullPath = expandPath(f.relPath);
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(fullPath)) {
          const content = f.content || readPluginSource(path.basename(f.relPath)) || "// CAITLYN plugin — source not found, reinstall caitlyn";
          fs.writeFileSync(fullPath, content, "utf-8");
          filesCreated.push(fullPath);
        }
      }
    }

    return {
      agent,
      success: true,
      message: install.postInstallMessage || `CAITLYN hooks installed for ${agent.name}.`,
      filesCreated,
      filesModified,
      dryRun,
    };
  } catch (err) {
    return {
      agent,
      success: false,
      message: `Failed to install hooks: ${String(err)}`,
      filesCreated,
      filesModified,
      dryRun,
    };
  }
}

// ── Uninstall ───────────────────────────────────────────────────────

export function uninstallAgent(agentId: string, dryRun = false): UninstallResult {
  const agent = AGENT_REGISTRY.find((a) => a.id === agentId);
  if (!agent) {
    return {
      agent: { id: agentId } as AgentSignature,
      success: false,
      message: `Unknown agent: ${agentId}`,
      filesRestored: [],
      filesRemoved: [],
      dryRun,
    };
  }

  if (dryRun) {
    const changes = dryRunUninstall(agentId);
    return {
      agent,
      success: true,
      message: `Dry-run: would make ${changes.length} change(s):\n${changes.map((c) => `  ${c.action} ${c.filePath}`).join("\n")}`,
      filesRestored: [],
      filesRemoved: [],
      dryRun,
    };
  }

  const install = agent.install;
  const filesRestored: string[] = [];
  const filesRemoved: string[] = [];

  try {
    // Restore from backup
    const configPath = expandPath(install.configPath);
    const backup = backupPath(configPath);
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, configPath);
      fs.unlinkSync(backup);
      filesRestored.push(configPath);
    }

    // Remove installed files
    if (install.uninstallFiles) {
      for (const f of install.uninstallFiles) {
        const fp = expandPath(f);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          filesRemoved.push(fp);
        }
      }
    }

    return {
      agent,
      success: true,
      message: `CAITLYN hooks removed for ${agent.name}.`,
      filesRestored,
      filesRemoved,
      dryRun,
    };
  } catch (err) {
    return {
      agent,
      success: false,
      message: `Failed to uninstall: ${String(err)}`,
      filesRestored,
      filesRemoved,
      dryRun,
    };
  }
}

// ── JSON Config Merging ─────────────────────────────────────────────

function mergeJsonConfig(configPath: string, patch: Record<string, unknown>): void {
  const fullPath = expandPath(configPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Backup existing config
  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, backupPath(fullPath));
  }

  // 2. Read existing config (or start fresh)
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  } catch {
    /* file doesn't exist or invalid — start fresh */
  }

  // 3. Apply patch
  const merged = applyJsonPatch(existing, patch);
  fs.writeFileSync(fullPath, JSON.stringify(merged, null, 2), "utf-8");
}

function applyJsonPatch(
  obj: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(obj));
  for (const [key, value] of Object.entries(patch)) {
    setNested(result, key, value);
  }
  return result;
}

function setNested(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const keys = dottedKey.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== "object") {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function getNested(obj: Record<string, unknown>, dottedKey: string): unknown {
  if (!dottedKey) return obj;
  const keys = dottedKey.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ── File Copy ───────────────────────────────────────────────────────

function copyFileConfig(configPath: string, content: string): void {
  const fullPath = expandPath(configPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  // Backup
  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, backupPath(fullPath));
  }

  fs.writeFileSync(fullPath, content, "utf-8");
}

// ── TOML Merge ──────────────────────────────────────────────────────

function mergeTomlConfig(
  configPath: string,
  patch?: { section: string; lines: string[] },
): void {
  if (!patch) return;
  const fullPath = expandPath(configPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  // 1. Backup
  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, backupPath(fullPath));
  }

  // 2. Read existing or start fresh
  let content: string;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    content = "";
  }

  // 3. Idempotency: check if section + lines already present
  const sectionHeader = `[${patch.section}]`;
  if (content.includes(sectionHeader)) {
    const allLinesPresent = patch.lines.every((line) => content.includes(line));
    if (allLinesPresent) return; // already configured
  }

  // 4. Append section if missing
  if (!content.includes(sectionHeader)) {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += `\n${sectionHeader}\n`;
    for (const line of patch.lines) {
      content += line + "\n";
    }
  } else {
    // Section exists but lines missing — append to section
    const lines = content.split("\n");
    const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);
    if (sectionIdx >= 0) {
      for (const line of patch.lines) {
        if (!content.includes(line)) {
          lines.splice(sectionIdx + 1, 0, line);
        }
      }
      content = lines.join("\n");
    }
  }

  fs.writeFileSync(fullPath, content, "utf-8");
}

// ── Codex-specific helper ───────────────────────────────────────────

export function enableCodexHooks(): boolean {
  const configPath = expandPath("~/.codex/config.toml");
  try {
    mergeTomlConfig(configPath, {
      section: "features",
      lines: ["codex_hooks = true"],
    });
    return true;
  } catch {
    return false;
  }
}
