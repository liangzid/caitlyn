# CAITLYN Agent — UX & Stability TODO

## P0 — Crashes & Critical Stability

- [ ] **Graceful LLM failure**: when API key missing or LLM call fails, show clear error and fall back to Tier 0 only instead of crashing
- [ ] **TUI crash recovery**: unhandled promise rejections in TUI should show error banner, not kill the process
- [ ] **Input validation**: reject empty/super-long content in scan; bound history size to prevent memory blow-up
- [ ] **File system resilience**: antibody/antigen directory missing → warn, don't crash; unreadable config.yaml → skip with warning, don't fail all loading

## P1 — Daemon UX (the "y/n" flow)

- [ ] **Auto-detect daemon on TUI start**: if `CAITLYND_URL` set but daemon unreachable, show "caitlynd daemon is not running. Start it? [y/N]"
  - `y` → spawn `cargo run -- --port 9070` (or `caitlynd` binary), poll health endpoint, show "Daemon ready" when live
  - `n` → continue in local mode silently
- [ ] **Daemon status indicator in TUI**: show real-time connection status with color (green dot = connected, yellow = local mode, red = error)
- [ ] **CLI scan: suggest daemon**: when `caitlyn scan` runs in local mode and takes >1s, print hint: "Tip: start caitlynd daemon for faster scans with more antibodies"
- [ ] **Daemon lifecycle**: when TUI exits, offer to stop the daemon if it was auto-started: "Stop caitlynd daemon? [y/N]"

## P2 — TUI Polish

- [ ] **Progress spinner during scan**: show `⠋ Scanning...` animation while scan is in flight; replace with result when done
- [ ] **Color-coded scan verdicts**: MALICIOUS = red background, SUSPICIOUS = yellow, BENIGN = green — use terminal colors for instant visual parsing
- [ ] **Scrollable chat history**: when messages overflow viewport, allow scrolling with PgUp/PgDn or arrow keys
- [ ] **Tab completion for commands**: `/sc<TAB>` → `/scan`, antibody IDs, etc.
- [ ] **Ctrl+C graceful exit**: intercept SIGINT, show "Goodbye", clean up, exit — not a raw stack trace
- [ ] **Status bar live updates**: refresh daemon status every 30s automatically; show scan count from history
- [ ] **Keyboard shortcuts bar**: always-visible footer row: `^C quit  /scan  /status  /dashboard  /help`
- [ ] **Message timestamps**: show relative time ("2m ago") next to each chat message

## P3 — Better Error Messages

- [ ] **LLM errors**: replace raw HTTP errors with actionable messages. E.g., `401` → "API key not valid. Set CAITLYN_PROVIDER and <PROVIDER>_API_KEY." `Connection refused` → "Cannot reach LLM API. Check network."
- [ ] **Missing dependencies**: on startup, check that `node` and `tsx` are available (for Tier 0 sandbox); warn if missing
- [ ] **Config validation**: on startup, validate config.yaml schema for each antibody; report which antibody has malformed config
- [ ] **Scan timeout**: if Tier 0 script hangs (>timeout), kill it and report timeout rather than hanging forever

## P4 — First-Run Experience

- [ ] **Onboarding banner**: first run → show quick-start: "Welcome to CAITLYN! Here's how to get started: 1) Start daemon, 2) Run your first scan, 3) Explore dashboard"
- [ ] **`caitlyn setup` command**: guided setup — check dependencies, create default config, test LLM connection, offer to build/start daemon
- [ ] **Sample content**: on fresh install with empty history, `caitlyn scan` without args → scan a built-in sample to demonstrate
- [ ] **Config file template**: `caitlyn init` writes a default config.toml with comments explaining each option

## P5 — Feature Gaps

- [ ] **Antibody CRUD from TUI**: `/antibody add <id>`, `/antibody remove <id>`, `/antibody edit <id>` — manage antibodies without leaving the TUI
- [ ] **Antigen view from TUI**: `/antigen <id>` — show full antigen payload and description
- [ ] **Export scan history**: `caitlyn history --export json` → dump history to file for analysis
- [ ] **Clear history**: `caitlyn history --clear` with confirmation
- [ ] **`caitlyn vaccinate <pattern>` CLI**: expose vaccination as a direct CLI command
- [ ] **Vaccination from TUI**: `/vaccinate <pattern>` with live progress feedback (LLM generation can take seconds)

## P6 — Code Quality

- [ ] **Replace `as unknown as AntibodyConfig` casts**: the YAML parser returns `Record<string, unknown>` then we force-cast. Add a runtime schema validator (or at least a type guard) so malformed YAML is caught at load time, not at use time
- [ ] **Extract parseYaml to its own file**: currently inlined in library.ts; it's a reusable utility
- [ ] **Add unit tests for parseYaml**: nested objects, lists, edge cases (empty file, only comments, deep nesting)
- [ ] **Add unit tests for normalizeConfig**: `_list_` conversion, stats defaults, parent_id null handling
- [ ] **Remove dead code in Rust**: the 4 warnings in mcp.rs (unused variables, dead structs) — either implement or `#[allow]` with reason
- [ ] **`~/caitlyn/~` directory**: already removed, but audit for any other stray artifacts from rename

## P7 — Docs & Polish

- [ ] **Update extension markdown files**: `caitlyn-system-prompt.md` and `caitlyn-security-prompt.md` still reference old tool names (`caitlyn_status` vs standalone tools)
- [ ] **Add `caitlyn help` command**: same as `--help` but accessible from both CLI and TUI
- [ ] **Shell script hardening**: `caitlyn` wrapper should check that node exists, that dist/cli.js exists; give clear error if not
- [ ] **README for caitlyn-agent**: document installation, usage, architecture

## P8 — UI Beautification (Caitlyn LoL Theme)

### Logo & Branding
- [ ] **Caitlyn-themed Unicode TUI logo**: replace current `ZERI`-era ASCII box with League of Legends Sheriff Caitlyn motif
  - Rifle/crosshair elements: `(╯°□°）╯︵ ┻━┻` → `▄︻デ══━💥` style sniper rifle
  - Trap motif: `╤╤╤╤` or bear-trap `🪤` (Unicode U+1FAA4) as subtle texture
  - Crosshair/target: `⊕` `◉` `◎` `⦿` `⌖` for the "aiming" feel — CAITLYN as a precision defense system
  - Top hat silhouette (Caitlyn's iconic hat): `╔═══╗` / `║ 🎩 ║` style
  - Final logo should be ~6-10 lines, render cleanly at 60-120 col width, use only box-drawing + common Unicode (no emoji that break in some terminals)
- [ ] **Splash/welcome banner redesign**: first frame on TUI launch — show logo prominently + one-line tagline "Continuous Agents for Injection Threats via Lifelong Yielding Nexus" + quick stats
- [ ] **Extension logo sync**: update `extension/caitlyn.ts` CAITLYN_LOGO constant to match new TUI logo

### TUI Visual Hierarchy
- [ ] **Color scheme**: define a proper palette instead of ad-hoc ANSI codes
  - Primary: cyan (Caitlyn's Piltover blue/teal)
  - Accent: gold/amber for threats and warnings
  - Danger: red (malicious verdicts)
  - Safe: green (clean scans)
  - Neutral: gray/dim for meta-info, timestamps, decorations
  - Background zones: subtle color blocks to separate header / chat / input / footer regions
- [ ] **Header bar**: always-visible top bar with `🎯 CAITLYN` logo mini + daemon status dot + antibody count + clock
- [ ] **Chat area**: alternating message backgrounds (subtle tint difference between user/assistant), message borders, role badges
- [ ] **Input area**: styled prompt `🎯 >` with blinking cursor, command hint below input line
- [ ] **Footer bar**: always-visible bottom bar with `F1:help  F2:scan  F3:dashboard  F4:history  ^C:quit`

### Command Autocomplete & Suggestions
- [ ] **Slash-command autocomplete**: as user types `/`, show popup with available commands
  - Fuzzy filter as user types more characters
  - Highlight matched portion in suggestions
  - Arrow keys to navigate, Enter to select, Tab to complete
- [ ] **Argument suggestions**: after selecting a command, show argument hints
  - `/scan` → hint "Enter content to scan..."
  - `/history` → hint "[N]  (default: 20)"
  - `/antibody` → list available antibody IDs as suggestions
  - `/antigen` → list available antigen IDs
- [ ] **Context-sensitive help**: `/help scan` → detailed usage for scan command; `/help` alone → command index
- [ ] **History recall**: up-arrow to recall previous commands (in-memory session history)

### Visual Feedback & Animation
- [ ] **Scan progress animation**: while scan is running, show animated crosshair: `⊕ scanning...` → `◉ analyzing...` → `◎ classifying...`
- [ ] **Verdict reveal animation**: when scan completes, "type out" the verdict character-by-character for dramatic effect (optional, disable-able)
- [ ] **Vaccination progress**: when `/vaccinate` runs, show the LLM mutation stages: `⚡ SHM mutating...` → `🧬 affinity testing...` → `💉 antibody born!`
- [ ] **Notification toasts**: transient top-right popups for events like "Daemon connected", "Scan complete", "New antibody evolved"

### Layout & Responsiveness
- [ ] **Resize handling**: TUI should gracefully handle terminal resize — recalculate widths, reflow markdown
- [ ] **Minimum terminal size check**: on startup, if terminal < 80×24, warn "CAITLYN works best at 80×24 or larger"
- [ ] **Overlay panels**: `/dashboard` should render as a centered overlay panel rather than inline chat message, dismiss with Escape
- [ ] **Split-pane mode** (stretch): antibody list on left, chat on right — for pro users

### Accessibility
- [ ] **High-contrast mode**: detect terminal background (dark/light) and adjust color palette
- [ ] **No-emoji mode**: `CAITLYN_NO_EMOJI=1` env var to strip all Unicode decorations, pure ASCII fallback
- [ ] **Screen reader friendly**: verdict text before emoji, not emoji-only indicators
