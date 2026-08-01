/**
 * CAITLYN Agent — Configuration
 *
 * Resolution order: env vars > config.toml > defaults.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CaitlynAgentConfig {
  provider: string;
  model: string;
  /** 轻量模型（评审/摘要等辅助任务），缺省回退 model。 */
  smallModel: string;
}

// ── Evolution (Immune System 2) Config ─────────────────────────────

export type EvolutionAutonomy = "record" | "candidate" | "auto";
export type DagContextMode = "meta" | "full";

/**
 * Configuration for the antibody evolution pipeline.
 *
 * Fields mirror the [evolution] TOML section; every field has a safe
 * default so the system runs even with no configuration file.
 */
export interface EvolutionConfig {
  /** 有样本路径的自治等级：record 只记录，candidate 生成候选，auto 直接固化。 */
  autonomy: EvolutionAutonomy;
  /** 无样本路径（未知威胁）的处置：同上，默认 candidate（泛化候选需确认）。 */
  unknownThreatAction: EvolutionAutonomy;
  /** 生成器读取 DAG 的上下文粒度：meta 只读结构化元数据，full 读完整内容。 */
  dagContext: DagContextMode;
  /** 生成器模型；null 表示继承 [llm].model。 */
  generatorModel: string | null;
  /** 评审模型；null 表示继承 [llm].small_model。 */
  reviewerModel: string | null;
  /** 每轮生成器一次产出的候选数量。 */
  candidatesPerRun: number;
  /** 单个免疫应答的最大循环轮数。 */
  maxRounds: number;
  /** 单个免疫应答的 token 预算。 */
  maxTokensPerRun: number;
  /** active 抗体数量硬上限，超出时淘汰 score 最低者。 */
  activeCap: number;
  /** score = hits - fpPenaltyWeight * FP 的误报惩罚权重。 */
  fpPenaltyWeight: number;
  /** score 时间衰减尺度（天）：超过该天数未使用则 score 衰减到 0。 */
  scoreDecayDays: number;
  /** dormant 保留天数，到期无人恢复则归档。 */
  dormantGraceDays: number;
  /** 无命中且存在覆盖后代时，超过该天数可退役为 dormant。 */
  retireInactiveDays: number;
  /** 确定性验证使用的良性样本数量。 */
  benignSamples: number;
  /** 良性样本允许的最大误报数。 */
  maxBenignFalsePositives: number;
  /** 正则签名验证超时（毫秒），防 ReDoS。 */
  regexTimeoutMs: number;
  /** shadow 观察窗口天数。 */
  shadowWindowDays: number;
  /** shadow 观察窗口的累计扫描次数（与天数先到为准）。 */
  shadowMinScans: number;
  /** 每抗原簇注入生成器的教训条数上限。 */
  lessonsPerCluster: number;
  /** 评审一致性抽查：accept 候选是否再独立评审一次（成本翻倍）。 */
  consistencyRecheck: boolean;
  /** 生成器参考的相似样本簇大小（防过拟合上下文，不进入硬约束）。 */
  similarSamples: number;
  /** 同一抗原簇触发免疫应答的冷却时间（分钟）。 */
  cooldownMinutes: number;
  /** 每日免疫应答次数上限（防成本攻击）。 */
  dailyEvolutionLimit: number;
  /** evolution 状态目录（DAG / lessons / 归档），默认 ~/.caitlyn/evolution。 */
  evolutionDir: string;
}

export const EVOLUTION_DEFAULTS: EvolutionConfig = {
  autonomy: "auto",
  unknownThreatAction: "candidate",
  dagContext: "meta",
  generatorModel: null,
  reviewerModel: null,
  candidatesPerRun: 3,
  maxRounds: 5,
  maxTokensPerRun: 40000,
  activeCap: 256,
  fpPenaltyWeight: 5,
  scoreDecayDays: 90,
  dormantGraceDays: 30,
  retireInactiveDays: 90,
  benignSamples: 5,
  maxBenignFalsePositives: 1,
  regexTimeoutMs: 200,
  shadowWindowDays: 7,
  shadowMinScans: 50,
  lessonsPerCluster: 10,
  consistencyRecheck: false,
  similarSamples: 3,
  cooldownMinutes: 60,
  dailyEvolutionLimit: 10,
  evolutionDir: path.join(os.homedir(), ".caitlyn", "evolution"),
};

/** Minimal TOML section reader — reads [section] key=value pairs. */
function readTomlSection(filePath: string, section: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let inSection = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const secMatch = trimmed.match(/^\[(\w+)\]$/);
      if (secMatch) {
        inSection = secMatch[1] === section;
        continue;
      }
      if (inSection) {
        const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
        if (kvMatch) {
          result[kvMatch[1]] = kvMatch[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
        }
      }
    }
  } catch {
    // Config file missing or unreadable — use defaults
  }
  return result;
}

export function loadConfig(): CaitlynAgentConfig {
  // 1. Check environment variables first
  const provider = process.env.CAITLYN_PROVIDER;
  const model = process.env.CAITLYN_MODEL;

  // 2. Fall back to config.toml [llm] section — search cwd and ancestors
  if (!provider || !model) {
    const configPath = findConfigUpward();
    const llm = readTomlSection(configPath, "llm");
    return {
      provider: provider ?? llm["provider"] ?? "openrouter",
      model: model ?? llm["model"] ?? "deepseek/deepseek-chat",
      smallModel: llm["small_model"] ?? model ?? llm["model"] ?? "deepseek/deepseek-chat",
    };
  }

  return { provider, model, smallModel: model };
}

/**
 * Find config.toml by searching cwd and its ancestors (like git).
 * Returns the path if found, or the default cwd path otherwise.
 */
function findConfigUpward(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "config.toml");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* not readable */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "config.toml");
}

// ── Evolution Config Loading ───────────────────────────────────────

const AUTONOMY_VALUES: readonly EvolutionAutonomy[] = ["record", "candidate", "auto"];
const DAG_CONTEXT_VALUES: readonly DagContextMode[] = ["meta", "full"];

function parseEnum<T extends string>(
  raw: Record<string, string>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = raw[key];
  if (value !== undefined && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

function parsePositiveNumber(
  raw: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeNumber(
  raw: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBoolean(raw: Record<string, string>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/**
 * Load the [evolution] TOML section with safe defaults.
 *
 * KEYPOINT-REVIEW: generator/reviewer 模型为 null 时表示继承 [llm] 段的
 * model / small_model；该继承在调用方（C6 LLM loop）完成，config 层不耦合。
 *
 * @param configPath 显式配置文件路径；缺省时沿 cwd 向上查找。
 */
export function loadEvolutionConfig(configPath?: string): EvolutionConfig {
  const resolved = configPath ?? findConfigUpward();
  const raw = readTomlSection(resolved, "evolution");
  const cfg: EvolutionConfig = { ...EVOLUTION_DEFAULTS };

  cfg.autonomy = parseEnum(raw, "autonomy", AUTONOMY_VALUES, cfg.autonomy);
  cfg.unknownThreatAction = parseEnum(
    raw,
    "unknown_threat_action",
    AUTONOMY_VALUES,
    cfg.unknownThreatAction,
  );
  cfg.dagContext = parseEnum(raw, "dag_context", DAG_CONTEXT_VALUES, cfg.dagContext);

  cfg.generatorModel = raw["generator_model"]?.trim() || null;
  cfg.reviewerModel = raw["reviewer_model"]?.trim() || null;

  cfg.candidatesPerRun = parsePositiveNumber(raw, "candidates_per_run", cfg.candidatesPerRun);
  cfg.maxRounds = parsePositiveNumber(raw, "max_rounds", cfg.maxRounds);
  cfg.maxTokensPerRun = parsePositiveNumber(raw, "max_tokens_per_run", cfg.maxTokensPerRun);
  cfg.activeCap = parsePositiveNumber(raw, "active_cap", cfg.activeCap);
  cfg.fpPenaltyWeight = parsePositiveNumber(raw, "fp_penalty_weight", cfg.fpPenaltyWeight);
  cfg.scoreDecayDays = parsePositiveNumber(raw, "score_decay_days", cfg.scoreDecayDays);
  cfg.dormantGraceDays = parsePositiveNumber(raw, "dormant_grace_days", cfg.dormantGraceDays);
  cfg.retireInactiveDays = parsePositiveNumber(raw, "retire_inactive_days", cfg.retireInactiveDays);
  cfg.benignSamples = parsePositiveNumber(raw, "benign_samples", cfg.benignSamples);
  cfg.maxBenignFalsePositives = parseNonNegativeNumber(
    raw,
    "max_benign_false_positives",
    cfg.maxBenignFalsePositives,
  );
  cfg.regexTimeoutMs = parsePositiveNumber(raw, "regex_timeout_ms", cfg.regexTimeoutMs);
  cfg.shadowWindowDays = parsePositiveNumber(raw, "shadow_window_days", cfg.shadowWindowDays);
  cfg.shadowMinScans = parsePositiveNumber(raw, "shadow_min_scans", cfg.shadowMinScans);
  cfg.lessonsPerCluster = parsePositiveNumber(raw, "lessons_per_cluster", cfg.lessonsPerCluster);
  cfg.consistencyRecheck = parseBoolean(raw, "consistency_recheck", cfg.consistencyRecheck);
  cfg.similarSamples = parsePositiveNumber(raw, "similar_samples", cfg.similarSamples);
  cfg.cooldownMinutes = parsePositiveNumber(raw, "cooldown_minutes", cfg.cooldownMinutes);
  cfg.dailyEvolutionLimit = parsePositiveNumber(raw, "daily_evolution_limit", cfg.dailyEvolutionLimit);

  const dir = raw["evolution_dir"]?.trim();
  if (dir) {
    cfg.evolutionDir = path.isAbsolute(dir)
      ? dir
      : path.resolve(path.dirname(resolved), dir);
  }

  return cfg;
}
