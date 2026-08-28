/**
 * CAITLYN curated antibody library integration tests.
 *
 * These tests exercise the shipped repository content rather than fixtures.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkLibraryIntegrity,
  invalidateLibraryCache,
  loadAntibodies,
} from "../src/library.js";
import { runTier0, shutdownTier0Pool } from "../src/scanner.js";

const ORIGINAL_LIBRARY_DIR = process.env.CAITLYN_LIBRARY_DIR;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");

const EXPECTED_RESEARCH_SKILLS = [
  "ab-agentflow-policy",
  "ab-camel-capability-flow",
  "ab-composkill-chain-audit",
  "ab-datasentinel",
  "ab-ipiguard-tool-graph",
  "ab-isolategpt-runtime",
  "ab-sara-action-authorization",
  "ab-secalign-model",
  "ab-skillsmetric-static-audit",
  "ab-struq-structured-query",
  "ab-task-shield",
  "ab-tool-minimize",
  "ab-tracegrant-contract",
  "ab-truss-skill-validation",
  "ab-trustshift-monitor",
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

describe("curated antibody library", () => {
  it("loads all documented entries with valid deployment metadata", () => {
    const antibodies = loadAntibodies();
    const ids = new Set(antibodies.map((antibody) => antibody.config.id));

    expect(antibodies).toHaveLength(39);
    expect(checkLibraryIntegrity(antibodies)).toEqual([]);
    for (const id of EXPECTED_RESEARCH_SKILLS) expect(ids.has(id)).toBe(true);
  });

  it("executes every active Tier 0 detector without a runtime error", async () => {
    const antibodies = loadAntibodies();
    const expectedIds = antibodies
      .filter((antibody) =>
        antibody.config.implementation_status === "active" &&
        antibody.config.role === "detector" &&
        antibody.config.tier === 0 &&
        antibody.scriptPath !== null
      )
      .map((antibody) => antibody.config.id)
      .sort();

    const { results } = await runTier0(
      antibodies,
      "Summarize the project documentation for the user.",
      2_000,
    );

    expect(results.map((result) => result.antibody_id).sort()).toEqual(expectedIds);
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.error === undefined)).toBe(true);
  });
});
