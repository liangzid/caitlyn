/**
 * Tests for the MCP proxy command-line entrypoint.
 */

import { describe, expect, it } from "vitest";
import { parseMcpProxyArgv } from "../src/mcp-proxy-args.js";

describe("parseMcpProxyArgv", () => {
  it("accepts a leading upstream separator", () => {
    expect(parseMcpProxyArgv(["--", "node", "server.js"])).toEqual({
      command: "node",
      args: ["server.js"],
    });
  });

  it("passes later separators through as upstream arguments", () => {
    expect(parseMcpProxyArgv(["node", "server.js", "--", "--stdio"])).toEqual({
      command: "node",
      args: ["server.js", "--", "--stdio"],
    });
  });

  it("rejects missing and help commands", () => {
    expect(parseMcpProxyArgv([])).toBeNull();
    expect(parseMcpProxyArgv(["--help"])).toBeNull();
  });
});
