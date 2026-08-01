/**
 * CAITLYN Evolution — LLM Loop Types
 *
 * Shared types for the generate-verify-review loop (immune System 2).
 */

import type { AntibodySignatureLike } from "./verifier.js";
import type { VerificationOutcome } from "./verifier.js";

/** 结构化抗原画像（L1：外部文本不整段进生成器）。 */
export interface AntigenProfile {
  clusterId: string;
  category: string;
  /** 提炼后的特征描述（由 daemon 从触发样本生成）。 */
  features: string[];
  /** 相似样本簇内容（参考上下文，防过拟合，不进入硬约束）。 */
  similarSamples?: string[];
  sampleCount: number;
}

/** 生成器产出的候选抗体草稿。 */
export interface CandidateDraft {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: number;
  parentIds: string[];
  signatures: AntibodySignatureLike[];
  rationale: string;
}

export type ReviewVerdict = "accept" | "revise" | "reject";

/** 独立评审单（强制 JSON schema）。 */
export interface ReviewSheet {
  verdict: ReviewVerdict;
  reason: string;
  suggestion: string;
  /** 与库内已有抗体的重复关系；null 表示不重复。 */
  duplicateOf: string | null;
}

export interface VerifiedCandidate {
  draft: CandidateDraft;
  verification: VerificationOutcome;
  review: ReviewSheet;
}

export type LoopTermination =
  | "accept"
  | "max_rounds"
  | "budget"
  | "generation_failed"
  | "record_mode";

export interface LoopResult {
  /** 通过确定性验证 + 独立评审的候选（已固化到 DAG）。 */
  approved: VerifiedCandidate[];
  lessonsWritten: number;
  rounds: number;
  tokensUsed: number;
  termination: LoopTermination;
}
