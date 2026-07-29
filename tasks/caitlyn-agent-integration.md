# CAITLYN Agent Integration — Task Document

*2026-07-28 — based on actual agent hook APIs*

## 1. Real Hook API Survey

All six target agents expose hook/middleware APIs for tool call interception.
The integration surface is better than expected.

### 1.1 Claude Code (Claude Agent SDK)

**Hook mechanism**: In-process callbacks via `ClaudeAgentOptions.hooks`.

```typescript
// TypeScript SDK
options: {
  hooks: {
    PreToolUse: [{
      matcher: "Bash",  // or "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", MCP tools
      hooks: [async (ctx) => {
        // ctx.tool_name, ctx.tool_input
        // Can BLOCK or modify params
        return { decision: "block", reason: "dangerous command" };
      }]
    }],
    PostToolUse: [{
      matcher: ".*",
      hooks: [async (ctx) => {
        // ctx.tool_name, ctx.tool_input, ctx.tool_result
        // Audit/log only (cannot undo the action)
      }]
    }]
  }
}
```

**Key facts**:
- `PreToolUse` fires after Claude has built tool params, before execution. Can **block** or **modify**.
- `PostToolUse` fires after tool completes. Audit/observe only.
- Matches on tool name: `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, custom MCP tools, etc.
- Python SDK has same hooks via `ClaudeAgentOptions`.
- Also has `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `PostToolUseFailure` (TS only).

**CAITLYN integration**: Write a `createClaudeAgentAdapter(engine)` that returns hook config objects ready to pass to `ClaudeAgentOptions`.

---

### 1.2 Codex CLI (OpenAI)

**Hook mechanism**: External command binaries, configured via `~/.codex/hooks.json`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/caitlyn-codex-hook",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/caitlyn-codex-hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

The hook binary receives a JSON event on stdin, returns a JSON decision on stdout.

**Key facts**:
- Must enable via `[features] codex_hooks = true` in `~/.codex/config.toml`.
- `PreToolUse` **only intercepts Bash/shell tool**. Does NOT fire for `Read`, `Write`, `Edit`, `apply_patch`, web fetch, or MCP tool calls.
- `PostToolUse` is **audit-only** — cannot modify/rewrite output.
- Also has `PermissionRequest`, `UserPromptSubmit`, `SessionStart`, `Stop`, `PreCompact`, `PostCompact`.
- Scope limitation: for file operations, MCP tools, and web fetch, hooks don't help. **FS Watcher** becomes the primary defense for Codex.

**CAITLYN integration**: Provide a `caitlyn-codex-hook` binary (thin wrapper around our scanner). Register it via `caitlyn install codex`. But acknowledge: Bash-only interception. FS Watcher must cover the rest.

---

### 1.3 OpenCode (SST)

**Hook mechanism**: JS/TS plugin API via `.opencode/plugin/`.

```typescript
// .opencode/plugin/caitlyn-plugin.ts
import type { PluginApi } from "@opencode-ai/plugin";

export default function main(api: PluginApi) {
  api.on("tool.execute.before", async (ctx) => {
    // ctx.input.tool — tool name
    // ctx.input.args — tool arguments
    // throw to block: throw new Error("blocked by CAITLYN");
    // mutate ctx.output.args to modify params
  });

  api.on("tool.execute.after", async (ctx) => {
    // ctx.input.tool, ctx.input.args
    // ctx.output.output — tool result
    // mutate ctx.output.output to modify/redact result
  });
}
```

**Key facts**:
- `tool.execute.before` — can **throw to block**, or mutate `output.args` to modify.
- `tool.execute.after` — can mutate `output.output`, `output.title`, `output.metadata`.
- Plugin loading order: global (~/.config/opencode/) → project (.opencode/).
- Also has `chat.message`, `chat.params`, `event`, `command.execute.before`, `permission.ask`.
- MCP tools are also intercepted via the same `tool.execute.before/after`.

**CAITLYN integration**: Publish `@caitlyn/opencode-plugin` npm package. User adds one line to `opencode.json`: `"plugin": ["@caitlyn/opencode-plugin"]`. The plugin wraps our engine.

---

### 1.4 Hermes Agent (Nous Research)

**Hook mechanism**: Plugin hook system via `ctx.register_hook("pre_tool_call", ...)`.

```python
# ~/.hermes/plugins/caitlyn_plugin.py
def register(ctx):
    async def pre_tool_call(tool_name, args, agent_context):
        # scan tool_name + args
        # return {"action": "block", "message": "blocked by CAITLYN"}
        # or return {"action": "allow"}
        pass
    
    ctx.register_hook("pre_tool_call", pre_tool_call)
```

**Key facts**:
- `pre_tool_call` fires before any tool executes. Can return `{"action": "block", "message": str}`.
- Plugins are installed under `~/.hermes/plugins/`.
- `SKILL.md` is for workflow instructions, NOT middleware — don't confuse.
- Gateway hooks (`~/.hermes/hooks/`) are for channel-level (Telegram/Discord), NOT CLI.
- Plugin hooks are the right API for CLI tool interception.

**CAITLYN integration**: Provide `caitlyn-hermes-plugin.py` in `~/.hermes/plugins/`. `caitlyn install hermes` copies it.

---

### 1.5 OpenClaw

**Hook mechanism**: Plugin hooks via `api.on('before_tool_call', ...)`.

```typescript
// openclaw plugin entry
export default function main(api: PluginApi) {
  api.on("before_tool_call", async (ctx) => {
    // ctx.tool — tool name
    // ctx.args — tool arguments
    // Can block, require approval, or allow
    return { action: "deny", reason: "blocked by CAITLYN" };
  });

  api.on("after_tool_call", async (ctx) => {
    // ctx.tool, ctx.args, ctx.result
    // Audit/log
  });
}
```

**Key facts**:
- `before_tool_call` — can **block**, require approval, or allow. Priority-ordered execution.
- `after_tool_call` — observe/audit.
- Plugin config in `openclaw.json` (or `~/.openclaw/openclaw.json`):
  ```json
  { "plugins": { "entries": { "caitlyn-guard": { "enabled": true } } } }
  ```
- Also has `on_input`, `on_output`, `on_context_assembly`, session lifecycle hooks.
- Real-world example: ClawBands is a security middleware using exactly these hooks.

**CAITLYN integration**: Publish `@caitlyn/openclaw-plugin` npm package. User adds to `openclaw.json`.

---

### 1.6 pi-coding-agent (Earendil Works)

**Hook mechanism**: Middleware via `agent.use()`.

```typescript
import { createPiAgentHookAdapter } from "caitlyn/guard";
agent.use(createPiAgentHookAdapter(engine).middleware);
```

**Already done** ✅. Implemented in `src/guard/agent-hooks.ts`.

---

## 2. Summary Matrix

| Agent | Hook API | Pre-tool block? | Post-tool modify? | Coverage | CAITLYN Adapter |
|---|---|---|---|---|---|
| **Claude Code** | In-process callback `PreToolUse`/`PostToolUse` | ✅ Block + modify params | ⚠️ Audit only | All tools (Bash, Edit, Write, Read, MCP) | `createClaudeAgentAdapter()` |
| **Codex CLI** | External binary `PreToolUse`/`PostToolUse` | ⚠️ Bash only | ❌ Audit only | Bash only — file/MCP tools NOT covered | `caitlyn-codex-hook` binary |
| **OpenCode** | Plugin `tool.execute.before`/`after` | ✅ throw to block + modify args | ✅ modify output | All tools incl. MCP | `@caitlyn/opencode-plugin` |
| **Hermes** | Plugin `pre_tool_call` | ✅ block with message | ❌ Not documented | All tools (inferred) | `caitlyn-hermes-plugin.py` |
| **OpenClaw** | Plugin `before_tool_call`/`after_tool_call` | ✅ block + require approval | ⚠️ Audit only | All tools | `@caitlyn/openclaw-plugin` |
| **pi-coding-agent** | Middleware `agent.use()` | ✅ block | ✅ modify result | All tools | Already done ✅ |

**Codex CLI is the weak link**: hook coverage is Bash-only. File operations (`Write`, `Edit`, `Read`), web fetch, and MCP tools bypass hooks entirely. For Codex, **FS Watcher** must be the primary defense mode — we can only augment it with Bash-command interception via hooks.

---

## 3. User Experience Design

### 3.1 The `caitlyn install` Command

One command per agent. CAITLYN writes the necessary config/plugin files.

```bash
caitlyn install claude-code    # adds PreToolUse/PostToolUse hooks to Claude config
caitlyn install codex          # writes ~/.codex/hooks.json + enables codex_hooks
caitlyn install opencode       # npm installs @caitlyn/opencode-plugin, adds to opencode.json
caitlyn install hermes         # copies caitlyn-hermes-plugin.py to ~/.hermes/plugins/
caitlyn install openclaw       # npm installs @caitlyn/openclaw-plugin, adds to openclaw.json
caitlyn install pi             # prints import instructions (or auto-injects for pi projects)
```

### 3.2 What `caitlyn install` Does Per Agent

| Agent | Install Action |
|---|---|
| **claude-code** | Creates `~/.claude/settings.json` (or merges) with `PreToolUse`/`PostToolUse` hooks pointing to CAITLYN engine |
| **codex** | Creates `~/.codex/hooks.json` with PreToolUse stub. Enables `codex_hooks = true` in config. Warns: "Bash-only coverage. FS Watcher recommended for file protection." |
| **opencode** | Runs `npm install @caitlyn/opencode-plugin`. Adds `"plugin": ["@caitlyn/opencode-plugin"]` to `opencode.json` (project or global). |
| **hermes** | Copies `caitlyn-hermes-plugin.py` to `~/.hermes/plugins/`. |
| **openclaw** | Runs `npm install @caitlyn/openclaw-plugin`. Adds plugin entry to `openclaw.json`. |
| **pi** | Updates `package.json` to include `caitlyn` dependency. Prints code snippet. |

### 3.3 Daily Use

After `caitlyn install <agent>`, the user runs their agent **normally**:

```bash
claude                          # hooks fire automatically
codex                           # hooks fire automatically (Bash only)
opencode                        # plugin loaded automatically
hermes --task "..."             # plugin loaded automatically
claw                            # plugin loaded automatically
```

No wrapper, no `caitlyn run`, no config editing after install. One `caitlyn install` and it's done.

---

## 4. Implementation Plan

### Phase 1: Adapter Library (Week 1-2)

Core adapters in `caitlyn-agent/src/adapters/`:

```
src/adapters/
  claude-agent.ts      — createClaudeAgentAdapter(engine) → ClaudeAgentOptions.hooks
  codex-hook.ts        — caitlyn-codex-hook binary (reads JSON stdin → scans → writes JSON stdout)
  opencode-plugin.ts   — @caitlyn/opencode-plugin entry (api.on("tool.execute.before", ...))
  hermes-plugin.py     — caitlyn-hermes-plugin.py (register_hook("pre_tool_call", ...))
  openclaw-plugin.ts   — @caitlyn/openclaw-plugin entry (api.on("before_tool_call", ...))
  pi-agent.ts          — Already done ✅
```

Each adapter is thin — ~30-60 lines wrapping the shared `AgentHooksEngine`.

### Phase 2: `caitlyn install` CLI (Week 2)

- [ ] Agent registry: known config paths, default directories, package names
- [ ] Config merger: merge hook config into existing agent config without clobbering user settings
- [ ] `caitlyn install <agent>` command
- [ ] `caitlyn install --dry-run` to preview changes
- [ ] `caitlyn uninstall <agent>` to remove

### Phase 3: Per-Agent Adapters (Week 2-3)

- [ ] **Claude Code**: in-process adapter using Claude Agent SDK types
- [ ] **Codex CLI**: standalone hook binary + JSON stdin/stdout protocol
- [ ] **OpenCode**: npm package `@caitlyn/opencode-plugin` with `tool.execute.before/after`
- [ ] **Hermes**: Python plugin file with `register_hook("pre_tool_call")`
- [ ] **OpenClaw**: npm package `@caitlyn/openclaw-plugin` with `before_tool_call`
- [ ] **pi-agent**: Already done ✅

### Phase 4: FS Watcher Integration (Week 3 — primarily for Codex)

Codex hooks only cover Bash. For file-based attacks, FS Watcher must monitor:
- `~/.codex/` — Codex session files
- Project workspace — files Codex reads/writes

- [ ] `caitlyn install codex` also configures FS Watcher for Codex paths
- [ ] Default FS Watcher presets for each agent

---

## 5. Design Decision: In-Process vs External Binary Adapters

For agents with in-process plugin APIs (Claude SDK, OpenCode, Hermes, OpenClaw), we
use **in-process adapters** — the CAITLYN engine runs inside the agent's process.
This gives us access to the full scanner (Tier 0 + Tier 1 LLM).

For Codex CLI, the only option is an **external binary** that communicates via
stdin/stdout JSON. This is inherently limited — the binary must be fast (no LLM
call per hook invocation). For Codex, the hook binary does Tier 0 (regex/script)
only. The FS Watcher handles deeper scanning.

---

## 6. Unit Tests Per Adapter

| Adapter | Tests |
|---|---|
| `claude-agent.ts` | Hook fires PreToolUse → scan → block. Hook fires PostToolUse → scan → flag. Malformed hook context → graceful degradation. |
| `codex-hook.ts` | Reads JSON stdin → scans → writes JSON stdout. Timeout → returns allow. Malformed stdin → error JSON. |
| `opencode-plugin.ts` | `tool.execute.before` throws → tool blocked. `tool.execute.after` mutates output → content replaced. Plugin loads without crashing agent. |
| `hermes-plugin.py` | `pre_tool_call` returns block → tool vetoed. `pre_tool_call` returns allow → tool proceeds. Plugin import errors → agent continues. |
| `openclaw-plugin.ts` | `before_tool_call` returns deny → tool blocked. `after_tool_call` fires → event logged. Plugin loads via `openclaw.json`. |
