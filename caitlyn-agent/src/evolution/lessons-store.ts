/**
 * CAITLYN Evolution — Lessons Store
 *
 * Reflexion-style failure memory. Append-only JSONL; every lesson must
 * come from a whitelisted source (verification or review) and must be a
 * structured record with no raw external text fields.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type LessonSource = "verification" | "review";
export type LessonReviewVerdict = "accept" | "revise" | "reject";

export interface LessonVerification {
  mustDetectPassed: boolean;
  falsePositiveCount: number;
  benignSampleCount: number;
}

export interface EvolutionLesson {
  id: string;
  /** 关联的抗原簇 id（触发样本的稳定标识）。 */
  clusterId: string;
  /** 循环轮次（1 起）。 */
  round: number;
  /** 来源白名单：verification | review。 */
  source: LessonSource;
  candidateId: string;
  /** 候选的结构化摘要（生成器可读，禁止原始注入文本）。 */
  candidateSummary: string;
  verification: LessonVerification;
  reviewVerdict: LessonReviewVerdict;
  /** 评审的具体建议（revise 时的下一步方向）。 */
  reviewSuggestion: string;
  /** 与上一轮相比的改动摘要。 */
  changeSinceLastRound: string;
  createdAt: string;
}

const SOURCES: readonly LessonSource[] = ["verification", "review"];
const VERDICTS: readonly LessonReviewVerdict[] = ["accept", "revise", "reject"];
/** Schema 允许的键；未知键（如 rawText）一律拒绝，防原始文本混入。 */
const ALLOWED_KEYS = new Set([
  "id",
  "clusterId",
  "round",
  "source",
  "candidateId",
  "candidateSummary",
  "verification",
  "reviewVerdict",
  "reviewSuggestion",
  "changeSinceLastRound",
  "createdAt",
]);

export class LessonsStore {
  private lessonsPath: string;
  private lessons: EvolutionLesson[] = [];

  constructor(evolutionDir: string) {
    this.lessonsPath = path.join(evolutionDir, "lessons.jsonl");
  }

  /** Load the append-only log into memory (oldest first). */
  load(): void {
    this.lessons = [];
    try {
      const raw = fs.readFileSync(this.lessonsPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const lesson = JSON.parse(line) as EvolutionLesson;
          if (this.isValidLesson(lesson)) this.lessons.push(lesson);
        } catch {
          // Skip malformed lines.
        }
      }
    } catch {
      // Missing file — start fresh.
    }
  }

  /**
   * Append a lesson. Rejects lessons from non-whitelisted sources,
   * with unknown fields, or with invalid shape.
   * KEYPOINT-REVIEW: 这是 L4 教训库投毒防护的第一道闸：schema 白名单 + 来源白名单。
   */
  append(
    lesson: Omit<EvolutionLesson, "id" | "createdAt"> & { createdAt?: string },
  ): EvolutionLesson {
    const full: EvolutionLesson = {
      ...lesson,
      id: randomUUID(),
      createdAt: lesson.createdAt ?? new Date().toISOString(),
    };
    if (!this.isValidLesson(full)) {
      throw new Error("Invalid lesson: unknown fields, source, or shape rejected");
    }
    fs.mkdirSync(path.dirname(this.lessonsPath), { recursive: true });
    fs.appendFileSync(this.lessonsPath, `${JSON.stringify(full)}\n`, "utf-8");
    this.lessons.push(full);
    return full;
  }

  /** Most recent lessons for a cluster, newest first, capped at k. */
  recentForCluster(clusterId: string, k: number): EvolutionLesson[] {
    return this.lessons
      .filter((l) => l.clusterId === clusterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, k));
  }

  /** All lessons in append order. */
  list(): EvolutionLesson[] {
    return [...this.lessons];
  }

  private isValidLesson(lesson: EvolutionLesson): boolean {
    const keys = Object.keys(lesson);
    if (keys.some((k) => !ALLOWED_KEYS.has(k))) return false;
    if (!SOURCES.includes(lesson.source)) return false;
    if (!VERDICTS.includes(lesson.reviewVerdict)) return false;
    if (!Number.isInteger(lesson.round) || lesson.round < 1) return false;
    if (typeof lesson.clusterId !== "string" || lesson.clusterId.length === 0) return false;
    if (typeof lesson.candidateId !== "string" || lesson.candidateId.length === 0) return false;
    if (typeof lesson.candidateSummary !== "string") return false;
    if (typeof lesson.reviewSuggestion !== "string") return false;
    if (typeof lesson.changeSinceLastRound !== "string") return false;
    if (typeof lesson.createdAt !== "string" || !Number.isFinite(Date.parse(lesson.createdAt))) {
      return false;
    }
    const v = lesson.verification;
    if (!v || typeof v !== "object") return false;
    if (typeof v.mustDetectPassed !== "boolean") return false;
    if (!Number.isInteger(v.falsePositiveCount) || v.falsePositiveCount < 0) return false;
    if (!Number.isInteger(v.benignSampleCount) || v.benignSampleCount < 0) return false;
    return true;
  }
}
