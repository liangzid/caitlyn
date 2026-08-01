/**
 * CAITLYN Evolution — Antibody DAG Types
 *
 * The immune System 2 antibody library: nodes carry lineage (parentIds),
 * runtime evidence, and a derived score used for retirement decisions.
 */

export type NodeStatus = "active" | "candidate" | "shadow" | "dormant" | "archived";

export interface AntibodyEvidence {
  /** 作为 active 抗体被扫描命中的次数。 */
  hits: number;
  /** 误报次数（评审/反馈确认）。 */
  falsePositives: number;
  /** 最后一次参与扫描的时间（ISO）；null 表示从未参与。 */
  lastUsedAt: string | null;
  /** shadow 模式下累计扫描次数（只记录不拦截）。 */
  shadowScans: number;
  /** shadow 模式下累计命中次数。 */
  shadowHits: number;
  /** shadow 命中中被后续确认为可疑事件的次数。 */
  shadowConfirmedHits: number;
}

export interface AntibodySignature {
  pattern: string;
  type: string;
  label: string;
}

export interface AntibodyNode {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: number;
  status: NodeStatus;
  /** DAG 血缘：直接父节点 id 列表（可为空 = 根抗体）。 */
  parentIds: string[];
  createdAt: string;
  /** 进入当前状态的时间（ISO）；dormant 时表示进入 dormant 的时间。 */
  statusChangedAt: string;
  generation: number;
  signatures: AntibodySignature[];
  evidence: AntibodyEvidence;
  /** 最近一次评审结论（accept/revise/reject）。 */
  lastReviewVerdict: string | null;
}

/** 决定 score 与退役行为的策略参数（来自 EvolutionConfig）。 */
export interface DagScorePolicy {
  activeCap: number;
  fpPenaltyWeight: number;
  scoreDecayDays: number;
  dormantGraceDays: number;
  retireInactiveDays: number;
}

export function createEmptyEvidence(): AntibodyEvidence {
  return {
    hits: 0,
    falsePositives: 0,
    lastUsedAt: null,
    shadowScans: 0,
    shadowHits: 0,
    shadowConfirmedHits: 0,
  };
}
