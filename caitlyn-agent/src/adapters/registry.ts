/**
 * CAITLYN Agent Registry
 *
 * Defines detection signatures and install logic for each supported agent.
 * Used by `caitlyn detect` and `caitlyn install` commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ───────────────────────────────────────────────────────────

export interface AgentSignature {
  /** Unique agent identifier. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** Description for the user. */
  description: string;

  /** How to integrate CAITLYN: "hooks" | "fs-watcher" | "both". */
  integrationMethod: "hooks" | "fs-watcher" | "both";

  /** Detection: paths that indicate this agent is installed. */
  detect: AgentDetection;

  /** Install: what to write where. */
  install: AgentInstall;
}

export interface AgentDetection {
  /** Binary names to look for in PATH. */
  binaries?: string[];

  /** Config file paths to check (supports ~ expansion). */
  configPaths?: string[];

  /** Directory paths whose existence indicates installation (supports ~). */
  dirPaths?: string[];

  /** For library agents: check package.json for dependency. */
  npmDependency?: string;
}

export interface AgentInstall {
  /** Config file to write/modify (supports ~). */
  configPath: string;

  /** Whether to merge into existing JSON or overwrite. */
  mergeStrategy: "merge-json" | "merge-toml" | "copy-file" | "print-instructions";

  /** Content to write or merge. For "copy-file": path to template file. */
  content?: string;

  /**
   * JSON path → value to set.
   * e.g. { "hooks.PreToolUse": [...] } sets hooks.PreToolUse in settings.json.
   */
  jsonPatch?: Record<string, unknown>;

  /** For TOML: [section] → { key: value }. */
  tomlPatch?: Record<string, Record<string, unknown>>;

  /** Additional files to create (e.g., plugin js/ts files). */
  additionalFiles?: Array<{ relPath: string; content: string }>;

  /** Human-readable post-install message. */
  postInstallMessage?: string;
}

export interface DetectResult {
  agent: AgentSignature;
  installed: boolean;
  /** Paths that confirmed detection. */
  foundPaths: string[];
  /** Install path (resolved from ~). */
  installPath: string;
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
      // not found in this dir
    }
  }
  return null;
}

/** Find the first existing path from a list. */
function findFirst(paths: string[]): string[] {
  const found: string[] = [];
  for (const p of paths) {
    const expanded = expandPath(p);
    try {
      fs.accessSync(expanded);
      found.push(expanded);
    } catch {
      // doesn't exist
    }
  }
  return found;
}

// ── Registry ────────────────────────────────────────────────────────

export const AGENT_REGISTRY: AgentSignature[] = [
  // ── Claude Code ────────────────────────────────────────────────
  {
    id: "claude-code",
    name: "Claude Code (Anthropic)",
    description: "Anthropic's CLI coding agent. Uses Claude Agent SDK with PreToolUse/PostToolUse hooks.",
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
      additionalFiles: [], // config.toml enable is handled separately
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
        plugin: ["@caitlyn/opencode-plugin"],
      },
      postInstallMessage:
        "OpenCode CAITLYN plugin configured. Run `npm install @caitlyn/opencode-plugin` to install the plugin package.\n" +
        "Then run `opencode` normally — hooks fire automatically.",
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
import json, os, subprocess, sys

def register(ctx):
    async def pre_tool_call(tool_name, args, agent_context):
        # Call caitlyn-hook binary for scanning
        try:
            input_data = json.dumps({
                "tool": tool_name,
                "args": args if isinstance(args, dict) else {"raw": str(args)},
            })
            result = subprocess.run(
                ["caitlyn-hook", "hermes"],
                input=input_data,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return {"action": "allow"}  # fail-open
            decision = json.loads(result.stdout)
            if decision.get("action") == "block":
                return {"action": "block", "message": decision.get("reason", "blocked by CAITLYN")}
        except Exception:
            pass  # fail-open on any error
        return {"action": "allow"}

    ctx.register_hook("pre_tool_call", pre_tool_call)
`,
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
          source: "@caitlyn/openclaw-plugin",
        },
      },
      postInstallMessage:
        "OpenClaw CAITLYN plugin configured. Run `npm install @caitlyn/openclaw-plugin` to install the plugin package.\n" +
        "Then restart the OpenClaw gateway: `openclaw gateway restart`.",
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

/** Detect which supported agents are installed on this system. */
export function detectAgents(): DetectResult[] {
  return AGENT_REGISTRY.map((agent) => {
    const foundPaths: string[] = [];

    // Check binaries
    if (agent.detect.binaries) {
      for (const bin of agent.detect.binaries) {
        const p = which(bin);
        if (p) foundPaths.push(p);
      }
    }

    // Check config paths
    if (agent.detect.configPaths) {
      foundPaths.push(...findFirst(agent.detect.configPaths));
    }

    // Check directories
    if (agent.detect.dirPaths) {
      foundPaths.push(...findFirst(agent.detect.dirPaths));
    }

    // Check npm dependency (look in cwd and ancestors for package.json)
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
          // no package.json or unreadable
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

// ── Install ─────────────────────────────────────────────────────────

export interface InstallResult {
  agent: AgentSignature;
  success: boolean;
  message: string;
  filesCreated: string[];
  filesModified: string[];
}

/** Install CAITLYN hooks into a specific agent. */
export function installAgent(agentId: string): InstallResult {
  const agent = AGENT_REGISTRY.find((a) => a.id === agentId);
  if (!agent) {
    return {
      agent: { id: agentId } as AgentSignature,
      success: false,
      message: `Unknown agent: ${agentId}. Supported: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`,
      filesCreated: [],
      filesModified: [],
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
        mergeTomlConfig(install.configPath, install.tomlPatch || {});
        filesModified.push(expandPath(install.configPath));
        break;

      case "print-instructions":
        // No file changes — user follows printed instructions
        break;
    }

    // Create additional files
    if (install.additionalFiles) {
      for (const f of install.additionalFiles) {
        const fullPath = expandPath(f.relPath);
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, f.content, "utf-8");
        filesCreated.push(fullPath);
      }
    }

    return {
      agent,
      success: true,
      message: install.postInstallMessage || `CAITLYN hooks installed for ${agent.name}.`,
      filesCreated,
      filesModified,
    };
  } catch (err) {
    return {
      agent,
      success: false,
      message: `Failed to install hooks: ${String(err)}`,
      filesCreated,
      filesModified,
    };
  }
}

// ── Config Merging ──────────────────────────────────────────────────

function mergeJsonConfig(configPath: string, patch: Record<string, unknown>): void {
  const fullPath = expandPath(configPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  // Read existing config
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  // Apply patch at dotted paths
  const merged = applyJsonPatch(existing, patch);
  fs.writeFileSync(fullPath, JSON.stringify(merged, null, 2), "utf-8");
}

function applyJsonPatch(
  obj: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(obj)); // deep clone
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

function copyFileConfig(configPath: string, content: string): void {
  const fullPath = expandPath(configPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function mergeTomlConfig(
  _configPath: string,
  _patch: Record<string, Record<string, unknown>>,
): void {
  // TOML merging is complex (preserve comments, ordering).
  // For now: if the file exists, append new sections. If not, create it.
  // Full TOML parser required for proper merge — defer to Phase 2.
  throw new Error("TOML merge not yet implemented. Please manually edit the config file.");
}

// ── Codex-specific: enable hooks in config.toml ─────────────────────

/** Enable codex_hooks feature flag in ~/.codex/config.toml. */
export function enableCodexHooks(): boolean {
  const configPath = expandPath("~/.codex/config.toml");
  try {
    let content: string;
    try {
      content = fs.readFileSync(configPath, "utf-8");
    } catch {
      // Create default config
      content = "";
    }

    if (content.includes("codex_hooks = true")) return true; // already enabled

    // Append or add [features] section
    if (content.includes("[features]")) {
      content = content.replace(/\[features\]/, "[features]\ncodex_hooks = true");
    } else {
      content += "\n[features]\ncodex_hooks = true\n";
    }

    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}
