# CAITLYN

**C**ontinuous **A**gents for **I**njection **T**hreats via **L**ifelong **Y**ielding **N**exus — an AI security guardian agent that protects LLM-powered toolchains from prompt injection, jailbreak, tool poisoning, and data exfiltration attacks. It maintains an antibody library (defense skills) and antigen library (attack samples), scans external content through a hybrid Tier 0 (script) / Tier 1 (LLM) pipeline, and can evolve new antibodies via LLM-guided vaccination to counter emergent threats.

## Quick Start

```bash
npm install
npm run build
./caitlyn          # start the TUI (default)
./caitlyn repl     # basic readline REPL
```

Node.js >= 22.19 required.

## Architecture

CAITLYN is a self-contained TypeScript agent backed by a Rust daemon:

- **TypeScript CLI / TUI** (`src/cli.ts`, `src/caitlyn-tui.ts`) — interactive terminal interface with chat, scan, and dashboard views
- **Rust daemon** (`caitlynd`) — optional background service for faster local scans with Tier 0 script antibodies
- **Antibody library** (`antibodies/`) — defense scripts organized as Tier 0 (fast, local) and Tier 1 (LLM-classified) detectors
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
# Tests:              # smoke test
npx tsx tests/smoke-scan.ts
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
  caitlynd-client.ts  Rust daemon client (optional, for fast local scans)
antibodies/           YAML detection scripts and configs
antigens/             Attack payload samples
extension/            VS Code / Cursor extension support files
  caitlyn.ts          Extension entry point
  caitlyn-system-prompt.md   Markdown system prompt for the extension
  caitlyn-security-prompt.md Markdown security prompt overlay
  caitlyn-helpers.py          Python helper utilities
```
