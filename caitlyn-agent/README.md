# CAITLYN

**C**ontinuous **A**gents for **I**njection **T**hreats via **L**ifelong **Y**ielding **N**exus — an AI security guardian agent that protects LLM-powered toolchains from prompt injection, jailbreak, tool poisoning, and data exfiltration attacks. It maintains an antibody library (defense skills) and antigen library (attack samples), scans external content through a hybrid Tier 0 (precompiled scripts) / Tier 1 (LLM) pipeline, and can evolve new antibodies via LLM-guided vaccination to counter emergent threats.

## Quick Start

```bash
npm install
npm run build
./caitlyn          # start the TUI (default)
./caitlyn repl     # basic readline REPL
```

Node.js >= 22.19 required.

## Architecture

CAITLYN is a self-contained TypeScript agent:

- **CLI / TUI** (`src/cli.ts`, `src/caitlyn-tui.ts`) — interactive terminal interface with chat, scan, and dashboard views
- **Hybrid Scanner** (`src/hybrid-scanner.ts`, `src/scanner.ts`) — Tier 0 (precompiled `.mjs` scripts) + Tier 1 (LLM-classified) detection pipeline
- **Evolution Engine** (`src/evolution/`) — cost-triggered vaccination: SHM → Affinity Maturation → Clonal Selection → new antibody generation
- **Antibody library** (`antibodies/`) — 20 defense scripts organized as Tier 0 (fast, local) and Tier 1 (LLM-classified) detectors
- **Antigen library** (`antigens/`) — known attack payloads for evaluation and regression testing

## Commands

| Command             | Description                                  |
|---------------------|----------------------------------------------|
| `caitlyn`           | Full-screen Terminal UI (default)            |
| `caitlyn help`      | Show usage                                   |
| `caitlyn tui`       | Full-screen Terminal UI                      |
| `caitlyn repl`      | Basic readline REPL                          |
| `caitlyn scan <c>`  | Quick security scan of content               |
| `caitlyn status`    | Show antibody / antigen library status       |
| `caitlyn dashboard` | Aggregated defense stats                     |
| `caitlyn history`   | Recent scan history (default 20, `history N` for N entries) |
| `caitlyn providers` | List available LLM providers                 |

## Environment Variables

| Variable            | Default                   | Description                    |
|---------------------|---------------------------|--------------------------------|
| `CAITLYN_PROVIDER`  | `openrouter`              | LLM provider for Tier 1 scans  |
| `CAITLYN_MODEL`     | `deepseek/deepseek-chat`  | Model ID for LLM calls         |

Other providers and models are detected from your `pi-ai` configuration.

## Development

```bash
npm install           # install dependencies
npm run build         # compile TypeScript → dist/
npm run dev           # run CLI directly with tsx (no build step)
npm test              # run all unit tests (226 tests, 9 files)
```

### Project Structure

```
src/
  cli.ts              CLI entry point (commands, arg parsing)
  caitlyn-tui.ts      Full-screen terminal UI (chat, scan, dashboard)
  agent.ts            Agent factory (system prompt, tools, model)
  system-prompt.ts    CAITLYN system prompt (persona, tool list, rules)
  tools.ts            Tool definitions registered with pi Agent harness
  scanner.ts          Tier 1 LLM scanner
  hybrid-scanner.ts   Tier 0 + Tier 1 hybrid scan pipeline
  library.ts          Antibody / antigen loading and evaluation
  history.ts          Scan history logging and dashboard queries
  schema.ts           TypeScript schemas for antibodies and antigens
  repl.ts             Simple readline REPL
  config.ts           Configuration (env vars, defaults)
  llm.ts              LLM provider discovery and resolution
  yaml-parser.ts      YAML parser for antibody config files
  evolution/          Evolution engine (vaccination pipeline)
    memory-bank.ts    Exact/regex signature fast-path matching
    cost-monitor.ts   Pattern cost tracking + vaccination trigger
    shm-engine.ts     LLM-driven antibody variant generation
    affinity.ts       Validation-set evaluation and scoring
    pipeline.ts       Full vaccination orchestration
    validation-set.ts JSONL attack/benign sample loader
    types.ts          Evolution type definitions
    index.ts          Module re-exports
  components/         TUI components
    scrollable-overlay.ts  Scrollable overlay panels
    overlays.ts       Overlay management
    footer.ts         Status bar footer
  commands/           TUI command handling
    handlers.ts       Command handlers
    slash-commands.ts Slash-command registry
  config/             Configuration management
    models.ts         Model registry
    credentials.ts    Credential resolution
  session/            Agent session management
    session-manager.ts Session persistence and compaction
    session-types.ts  Session type definitions
  scripts/            Build scripts
    precompile-antibodies.ts  Precompile Tier 0 detect.ts → .mjs
antibodies/           YAML detection scripts and configs (20 antibodies)
antigens/             Attack payload samples (6 antigens)
extension/            VS Code / Cursor extension support files
  caitlyn.ts          Extension entry point
  caitlyn-system-prompt.md   Markdown system prompt for the extension
  caitlyn-security-prompt.md Markdown security prompt overlay
  caitlyn-helpers.py          Python helper utilities
tests/                9 test files, 226 test cases
```
