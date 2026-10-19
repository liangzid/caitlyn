/**
 * CLI help must list the live commands, including ones that used to be omitted.
 */

import { describe, expect, it } from "vitest";
import { formatCliHelp, formatUnknownCommand } from "../src/cli-help.js";

describe("cli help", () => {
  it("lists repl, privacy, daemon, watch, releases, and install --force", () => {
    const help = formatCliHelp();
    expect(help).toContain("repl");
    expect(help).toContain("privacy");
    expect(help).toContain("daemon");
    expect(help).toContain("watch");
    expect(help).toContain("os-watch");
    expect(help).toContain("releases");
    expect(help).toContain("whats-new");
    expect(help).toContain("--force");
    expect(help).toContain("--redteam");
    expect(help).toContain("init");
  });

  it("names every live command on the unknown-command usage line", () => {
    const text = formatUnknownCommand("nope");
    expect(text).toContain("Unknown command: nope");
    for (const name of [
      "tui",
      "repl",
      "scan",
      "privacy",
      "daemon",
      "watch",
      "os-watch",
      "releases",
      "synthesize",
      "help",
    ]) {
      expect(text).toContain(name);
    }
  });
});
