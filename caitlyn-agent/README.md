# CAITLYN

CAITLYN is an adaptive security middleware for LLM agents. It scans untrusted
content through a fast executable-skill layer and a context-sensitive LLM
layer, and can synthesize verified defense skills from new counterexamples.

Full documentation, architecture, evaluation results, and limitations are
available in the
[project repository](https://github.com/liangzid/caitlyn#readme).

## Install

CAITLYN requires Node.js 22.19 or newer.

Install the command-line interface globally:

```bash
npm install -g caitlyn
caitlyn status
caitlyn
```

The package also installs `caitlyn-hook`, which is used by supported agent
integrations.

For project-local use:

```bash
npm install caitlyn
npx caitlyn status
```

Tier 0 scanning works without an API key. Tier 1 and defense synthesis require
a supported model provider. The guided setup writes provider, Agent, and
detection settings only after a final confirmation:

```bash
caitlyn setup
```

`caitlyn setup --no-connection-test` skips the live API probe. `/setup` in the
TUI runs the same flow. Alternatively, export a provider key:

```bash
export OPENROUTER_API_KEY="your-key"
```

## Protect an agent

```bash
caitlyn detect
caitlyn install --dry-run codex
caitlyn install codex
caitlyn daemon start
caitlyn watch --status
```

Supported adapters include Claude Code, Codex, OpenCode, Hermes, OpenClaw, and
Pi Coding Agent. Configuration changes are backed up before installation.

## Commands

| Command | Purpose |
| --- | --- |
| `caitlyn` or `caitlyn tui` | Open the full-screen terminal interface |
| `caitlyn scan <content>` | Scan content |
| `caitlyn status` | Inspect the defense and attack libraries |
| `caitlyn detect` | Detect supported agents |
| `caitlyn setup` | Guided provider, Agent, and detection setup |
| `caitlyn install <agent>` | Install an agent integration |
| `caitlyn uninstall <agent>` | Remove an integration and restore its backup |
| `caitlyn daemon start\|stop\|status` | Manage the local daemon |
| `caitlyn vaccinate <pattern>` | Submit a System II trigger |
| `caitlyn update --check` | Check for a newer release |

## Library use

The package exposes its scanner and filesystem-native defense library:

```ts
import {
  createUnavailableLlmCall,
  loadAntibodies,
  loadAntigens,
  scan,
} from "caitlyn";

const result = await scan({
  antibodies: loadAntibodies(),
  antigens: loadAntigens(),
  content: "untrusted content",
  llmCall: createUnavailableLlmCall("Tier 0 only"),
});
```

## License

MIT
