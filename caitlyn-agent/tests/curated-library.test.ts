/**
 * CAITLYN curated defense skill library integration tests.
 *
 * These tests exercise the shipped repository content rather than fixtures.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkLibraryIntegrity,
  invalidateLibraryCache,
  loadDefenseSkills,
} from "../src/library.js";
import { runTier0, shutdownTier0Pool } from "../src/scanner.js";

const ORIGINAL_LIBRARY_DIR = process.env.CAITLYN_LIBRARY_DIR;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");

const EXPECTED_RESEARCH_SKILLS = [
  "agentflow-policy",
  "camel-capability-flow",
  "composkill-chain-audit",
  "datasentinel",
  "ipiguard-tool-graph",
  "isolategpt-runtime",
  "sara-action-authorization",
  "secalign-model",
  "skillsmetric-static-audit",
  "struq-structured-query",
  "task-shield",
  "tool-minimize",
  "tracegrant-contract",
  "truss-skill-validation",
  "trustshift-monitor",
];

beforeAll(() => {
  process.env.CAITLYN_LIBRARY_DIR = REPOSITORY_ROOT;
  invalidateLibraryCache();
});

afterAll(() => {
  shutdownTier0Pool();
  if (ORIGINAL_LIBRARY_DIR === undefined) delete process.env.CAITLYN_LIBRARY_DIR;
  else process.env.CAITLYN_LIBRARY_DIR = ORIGINAL_LIBRARY_DIR;
  invalidateLibraryCache();
});

describe("curated defense skill library", () => {
  it("loads all documented entries with valid deployment metadata", () => {
    const defenseSkills = loadDefenseSkills();
    const ids = new Set(defenseSkills.map((defenseSkill) => defenseSkill.config.id));

    expect(defenseSkills).toHaveLength(39);
    expect(checkLibraryIntegrity(defenseSkills)).toEqual([]);
    for (const id of EXPECTED_RESEARCH_SKILLS) expect(ids.has(id)).toBe(true);
  });

  it("executes every active Tier 0 detector without a runtime error", async () => {
    const defenseSkills = loadDefenseSkills();
    const expectedIds = defenseSkills
      .filter((defenseSkill) =>
        defenseSkill.config.implementation_status === "active" &&
        defenseSkill.config.role === "detector" &&
        defenseSkill.config.tier === 0 &&
        defenseSkill.scriptPath !== null
      )
      .map((defenseSkill) => defenseSkill.config.id)
      .sort();

    const { results } = await runTier0(
      defenseSkills,
      "Summarize the project documentation for the user.",
      2_000,
    );

    expect(results.map((result) => result.defense_skill_id).sort()).toEqual(expectedIds);
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.error === undefined)).toBe(true);
  });
});
