/**
 * Tests for ACE component inventory and mutation energy.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyComponentPath,
  diffComponentGraph,
  inventoryComponentGraph,
} from "../../src/guard/component-graph.js";

describe("classifyComponentPath", () => {
  it("maps skill, mcp, config, and command paths", () => {
    expect(classifyComponentPath("skills/foo/SKILL.md")).toBe("skill");
    expect(classifyComponentPath("mcp.json")).toBe("mcp");
    expect(classifyComponentPath("settings.json")).toBe("config");
    expect(classifyComponentPath("commands/review.md")).toBe("command");
    expect(classifyComponentPath("notes.txt")).toBe("other");
  });
});

describe("inventoryComponentGraph and diff", () => {
  it("treats the first snapshot as baseline, then counts a skill graft", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-ace-"));
    fs.mkdirSync(path.join(root, "skills", "benign"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "benign", "SKILL.md"), "name: benign\n");
    fs.writeFileSync(path.join(root, "settings.json"), "{}\n");

    const first = inventoryComponentGraph([root]);
    const baseline = diffComponentGraph(null, first);
    expect(baseline.energy).toBe(0);
    expect(first.nodes.size).toBeGreaterThanOrEqual(2);

    fs.mkdirSync(path.join(root, "skills", "grafted"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "grafted", "SKILL.md"), "name: grafted\n");
    const second = inventoryComponentGraph([root]);
    const diff = diffComponentGraph(first, second);
    expect(diff.energy).toBeGreaterThanOrEqual(1);
    expect(diff.added.some((n) => n.class === "skill")).toBe(true);
  });
});
