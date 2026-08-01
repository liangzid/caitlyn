/**
 * Tests for the [evolution] TOML configuration loading.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVOLUTION_DEFAULTS, loadEvolutionConfig } from "../src/config.js";

function writeToml(dir: string, body: string): string {
  const file = path.join(dir, "config.toml");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

describe("loadEvolutionConfig", () => {
  it("returns defaults when the config file does not exist", () => {
    const cfg = loadEvolutionConfig("/nonexistent/caitlyn/config.toml");
    expect(cfg).toEqual(EVOLUTION_DEFAULTS);
  });

  it("loads every field from a full [evolution] section", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-evo-cfg-"));
    const file = writeToml(
      dir,
      [
        "[llm]",
        'provider = "deepseek"',
        'model = "deepseek-v4-pro"',
        'small_model = "deepseek-v4-flash"',
        "",
        "[evolution]",
        'autonomy = "record"',
        'unknown_threat_action = "auto"',
        'dag_context = "full"',
        'generator_model = "g-test"',
        'reviewer_model = "r-test"',
        "candidates_per_run = 7",
        "max_rounds = 9",
        "max_tokens_per_run = 12345",
        "active_cap = 64",
        "fp_penalty_weight = 2",
        "score_decay_days = 30",
        "dormant_grace_days = 5",
        "retire_inactive_days = 20",
        "benign_samples = 8",
        "max_benign_false_positives = 0",
        "regex_timeout_ms = 50",
        "shadow_window_days = 3",
        "shadow_min_scans = 10",
        "lessons_per_cluster = 4",
        "similar_samples = 2",
        "cooldown_minutes = 15",
        "daily_evolution_limit = 2",
        'evolution_dir = "./evo-state"',
        "",
      ].join("\n"),
    );

    const cfg = loadEvolutionConfig(file);
    expect(cfg.autonomy).toBe("record");
    expect(cfg.unknownThreatAction).toBe("auto");
    expect(cfg.dagContext).toBe("full");
    expect(cfg.generatorModel).toBe("g-test");
    expect(cfg.reviewerModel).toBe("r-test");
    expect(cfg.candidatesPerRun).toBe(7);
    expect(cfg.maxRounds).toBe(9);
    expect(cfg.maxTokensPerRun).toBe(12345);
    expect(cfg.activeCap).toBe(64);
    expect(cfg.fpPenaltyWeight).toBe(2);
    expect(cfg.scoreDecayDays).toBe(30);
    expect(cfg.dormantGraceDays).toBe(5);
    expect(cfg.retireInactiveDays).toBe(20);
    expect(cfg.benignSamples).toBe(8);
    expect(cfg.maxBenignFalsePositives).toBe(0);
    expect(cfg.regexTimeoutMs).toBe(50);
    expect(cfg.shadowWindowDays).toBe(3);
    expect(cfg.shadowMinScans).toBe(10);
    expect(cfg.lessonsPerCluster).toBe(4);
    expect(cfg.similarSamples).toBe(2);
    expect(cfg.cooldownMinutes).toBe(15);
    expect(cfg.dailyEvolutionLimit).toBe(2);
    expect(cfg.evolutionDir).toBe(path.resolve(dir, "evo-state"));
  });

  it("falls back to defaults for invalid enum and non-positive numbers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-evo-cfg-"));
    const file = writeToml(
      dir,
      [
        "[evolution]",
        'autonomy = "nonsense"',
        'dag_context = "half"',
        "max_rounds = -3",
        "active_cap = 0",
        "regex_timeout_ms = abc",
        "",
      ].join("\n"),
    );

    const cfg = loadEvolutionConfig(file);
    expect(cfg.autonomy).toBe(EVOLUTION_DEFAULTS.autonomy);
    expect(cfg.dagContext).toBe(EVOLUTION_DEFAULTS.dagContext);
    expect(cfg.maxRounds).toBe(EVOLUTION_DEFAULTS.maxRounds);
    expect(cfg.activeCap).toBe(EVOLUTION_DEFAULTS.activeCap);
    expect(cfg.regexTimeoutMs).toBe(EVOLUTION_DEFAULTS.regexTimeoutMs);
  });

  it("ignores other TOML sections", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-evo-cfg-"));
    const file = writeToml(
      dir,
      [
        "[llm]",
        'model = "other"',
        "",
        "[vaccination]",
        "min_samples = 99",
        "",
      ].join("\n"),
    );

    const cfg = loadEvolutionConfig(file);
    expect(cfg).toEqual(EVOLUTION_DEFAULTS);
  });

  it("treats empty model overrides as inherit (null)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-evo-cfg-"));
    const file = writeToml(
      dir,
      [
        "[evolution]",
        'generator_model = ""',
        'reviewer_model = ""',
        "",
      ].join("\n"),
    );

    const cfg = loadEvolutionConfig(file);
    expect(cfg.generatorModel).toBeNull();
    expect(cfg.reviewerModel).toBeNull();
  });

  it("parses the consistency_recheck boolean with a safe default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-evo-cfg-"));
    const on = writeToml(
      dir,
      ["[evolution]", "consistency_recheck = true", ""].join("\n"),
    );
    expect(loadEvolutionConfig(on).consistencyRecheck).toBe(true);

    const off = writeToml(
      dir,
      ["[evolution]", "consistency_recheck = false", ""].join("\n"),
    );
    expect(loadEvolutionConfig(off).consistencyRecheck).toBe(false);

    const bad = writeToml(
      dir,
      ["[evolution]", "consistency_recheck = maybe", ""].join("\n"),
    );
    expect(loadEvolutionConfig(bad).consistencyRecheck).toBe(
      EVOLUTION_DEFAULTS.consistencyRecheck,
    );
  });
});
