/**
 * CAITLYN Evolution — Stats Collector
 *
 * Trigger layer of immune System 2. Event producers append observations
 * to events.jsonl; the daemon-side collector incrementally builds an
 * EWMA + p99 baseline per metric and raises anomaly triggers when a new
 * observation far exceeds the baseline. Baseline and trigger state are
 * persisted to baseline.json so restarts do not forget the model.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type StatsEventSource = "agent_behavior" | "filesystem" | "os_network" | "evolution_self";

export interface StatsEvent {
  source: StatsEventSource;
  metric: string;
  value: number;
  at: string;
  meta?: Record<string, unknown>;
}

export interface BaselineModel {
  ewma: number;
  p99: number;
  sampleCount: number;
  updatedAt: string;
  /** 最近窗口内的观测（值 + 时间戳，用于 p99 计算与超窗裁剪）。 */
  values: Array<{ value: number; at: string }>;
}

export interface AnomalyTrigger {
  source: StatsEventSource;
  metric: string;
  value: number;
  baselineEwma: number;
  baselineP99: number;
  at: string;
}

export interface StatsCollectorConfig {
  ewmaAlpha: number;
  windowMs: number;
  anomalyFactor: number;
  minAbsoluteDelta: number;
  cooldownMinutes: number;
  dailyEvolutionLimit: number;
}

export const STATS_COLLECTOR_DEFAULTS: StatsCollectorConfig = {
  ewmaAlpha: 0.2,
  windowMs: 60 * 60 * 1000,
  anomalyFactor: 3,
  minAbsoluteDelta: 1,
  cooldownMinutes: 60,
  dailyEvolutionLimit: 10,
};

interface PersistedState {
  baselines: Record<string, BaselineModel>;
  /** events.jsonl 中已处理的行数（全局游标，保证增量幂等）。 */
  lastEventIndex: number;
  lastTriggerAt: Record<string, string>;
  triggersToday: { date: string; count: number };
}

function emptyBaseline(): BaselineModel {
  return {
    ewma: 0,
    p99: 0,
    sampleCount: 0,
    updatedAt: "",
    values: [],
  };
}

/** Nearest-rank p99 over a value list. */
export function computeP99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.99 * sorted.length) - 1;
  return sorted[Math.max(0, rank)];
}

export class StatsCollector {
  private eventsPath: string;
  private baselinePath: string;
  private config: StatsCollectorConfig;
  private state: PersistedState = {
    baselines: {},
    lastEventIndex: 0,
    lastTriggerAt: {},
    triggersToday: { date: "", count: 0 },
  };

  constructor(statsDir: string, config: Partial<StatsCollectorConfig> = {}) {
    this.eventsPath = path.join(statsDir, "events.jsonl");
    this.baselinePath = path.join(statsDir, "baseline.json");
    this.config = { ...STATS_COLLECTOR_DEFAULTS, ...config };
  }

  /** Event producers: stateless append of one observation. */
  appendEvent(event: StatsEvent): void {
    fs.mkdirSync(path.dirname(this.eventsPath), { recursive: true });
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  /** Load persisted baseline/trigger state. */
  load(): void {
    try {
      const raw = fs.readFileSync(this.baselinePath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = {
        baselines: parsed.baselines ?? {},
        lastEventIndex: parsed.lastEventIndex ?? 0,
        lastTriggerAt: parsed.lastTriggerAt ?? {},
        triggersToday: parsed.triggersToday ?? { date: "", count: 0 },
      };
    } catch {
      // Missing or corrupt — start fresh.
    }
  }

  /**
   * Process new events since the last collect() and return anomaly
   * triggers. Idempotent: events already processed are skipped.
   */
  collect(now: Date = new Date()): AnomalyTrigger[] {
    const events = this.readEvents();
    const triggers: AnomalyTrigger[] = [];
    const today = now.toISOString().slice(0, 10);
    if (this.state.triggersToday.date !== today) {
      this.state.triggersToday = { date: today, count: 0 };
    }

    const windowStart = now.getTime() - this.config.windowMs;
    for (let i = this.state.lastEventIndex; i < events.length; i++) {
      const event = events[i];
      if (!event || !Number.isFinite(event.value)) continue;
      const baseline = this.baselineFor(event.metric);
      this.pruneWindow(baseline, windowStart);

      const trigger = this.evaluate(event, baseline, now);
      if (trigger && this.canTrigger(trigger.metric, now)) {
        this.state.lastTriggerAt[trigger.metric] = now.toISOString();
        this.state.triggersToday.count += 1;
        triggers.push(trigger);
      }

      this.updateBaseline(baseline, event, now);
    }

    this.state.lastEventIndex = events.length;
    this.save();
    return triggers;
  }

  /** Baseline snapshot for a metric (created on demand). */
  baselineFor(metric: string): BaselineModel {
    let baseline = this.state.baselines[metric];
    if (!baseline) {
      baseline = emptyBaseline();
      this.state.baselines[metric] = baseline;
    }
    return baseline;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.baselinePath), { recursive: true });
    const tmp = `${this.baselinePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    fs.renameSync(tmp, this.baselinePath);
  }

  /** All raw events (for tests and auditing). */
  readEvents(): StatsEvent[] {
    try {
      const raw = fs.readFileSync(this.eventsPath, "utf-8");
      const out: StatsEvent[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as StatsEvent);
        } catch {
          // Skip malformed lines.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private evaluate(
    event: StatsEvent,
    baseline: BaselineModel,
    now: Date,
  ): AnomalyTrigger | null {
    if (baseline.sampleCount === 0) return null; // no baseline yet
    const reference = Math.max(baseline.p99, baseline.ewma);
    const threshold = Math.max(
      reference * this.config.anomalyFactor,
      baseline.ewma + this.config.minAbsoluteDelta,
    );
    if (event.value <= threshold) return null;
    return {
      source: event.source,
      metric: event.metric,
      value: event.value,
      baselineEwma: baseline.ewma,
      baselineP99: baseline.p99,
      at: now.toISOString(),
    };
  }

  private canTrigger(metric: string, now: Date): boolean {
    if (this.state.triggersToday.count >= this.config.dailyEvolutionLimit) return false;
    const last = this.state.lastTriggerAt[metric];
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return true;
    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    return now.getTime() - lastMs >= cooldownMs;
  }

  private updateBaseline(baseline: BaselineModel, event: StatsEvent, now: Date): void {
    baseline.values.push({ value: event.value, at: event.at });
    baseline.ewma =
      baseline.sampleCount === 0
        ? event.value
        : this.config.ewmaAlpha * event.value + (1 - this.config.ewmaAlpha) * baseline.ewma;
    baseline.p99 = computeP99(baseline.values.map((v) => v.value));
    baseline.sampleCount += 1;
    baseline.updatedAt = now.toISOString();
  }

  private pruneWindow(baseline: BaselineModel, windowStart: number): void {
    baseline.values = baseline.values.filter((v) => Date.parse(v.at) >= windowStart);
  }
}
