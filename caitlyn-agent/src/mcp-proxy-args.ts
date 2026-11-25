/**
 * Command-line parsing for `caitlyn-mcp-proxy`.
 * Kept separate from the binary entrypoint so tests can import it without
 * starting the stdio proxy.
 */

export interface McpProxyCommand {
  command: string;
  args: string[];
}

/** Parse the upstream command. A leading `--` is optional; later separators belong to upstream. */
export function parseMcpProxyArgv(argv: string[]): McpProxyCommand | null {
  const parts = argv[0] === "--" ? argv.slice(1) : argv;
  if (parts.length === 0 || parts[0] === "--help" || parts[0] === "-h") return null;
  return { command: parts[0], args: parts.slice(1) };
}
