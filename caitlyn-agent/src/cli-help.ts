/**
 * CAITLYN Agent — CLI help text
 *
 * Keep this list in lockstep with the switch cases in cli.ts.
 */

/**
 * Full `caitlyn help` page, including commands that used to be missing from the printed list.
 */
export function formatCliHelp(): string {
  return [
    "CAITLYN — Continuous Agents for Injection Threats via Lifelong Yielding Nexus",
    "",
    "Usage: caitlyn <command> [options]",
    "",
    "Commands:",
    "  tui                        Full-screen Terminal UI (default)",
    "  repl                       Readline REPL for scan and slash commands",
    "  scan <content>             Quick security scan",
    "  privacy <sanitize|restore> [--level standard|strict] <text>",
    "                             Mask or restore identifiers on the CLI",
    "  status                     Show defense skill/attack library status",
    "  dashboard                  Show defense stats dashboard",
    "  history [N]                Show recent scan history (default 20)",
    "  history --export json [p]  Export scan history to file",
    "  history --clear            Clear all scan history",
    "  detect                     Scan system for supported agents",
    "  install [--dry-run] [--force] <a>",
    "                             Inject hooks, or refresh copied plugins",
    "  uninstall [--dry-run] <a>  Remove CAITLYN hooks, restore backup",
    "  providers                  List available LLM providers",
    "  init                       Generate default config.toml",
    "  setup [--config p] [--no-connection-test]",
    "                             Guided provider, Agent, and detection setup",
    "  releases                   Dated What's New page (whats-new is the same)",
    "  synthesize <pattern>        Submit synthesis pattern",
    "  synthesize --approve <id>  Activate a shadow candidate",
    "  synthesize --status        Show the evolution DAG",
    "  synthesize --redteam [cat] Run the active red-team drill",
    "  daemon [start|stop|status] Manage the local scanning daemon",
    "  watch [--add <dir>]        Add filesystem observation paths",
    "  update [--check] [--yes]   Check GitHub release / npm update",
    "  contribute                 Pack library into library/incoming bundle",
    "  help                       Show this help",
    "",
  ].join("\n");
}

/**
 * Usage line printed for unknown commands. Must name every live command.
 */
export function formatUnknownCommand(command: string): string {
  return [
    `Unknown command: ${command}`,
    "Usage: caitlyn [tui|repl|scan|privacy|status|dashboard|history|detect|install|uninstall|providers|init|setup|releases|synthesize|daemon|watch|update|contribute|help]",
  ].join("\n");
}
