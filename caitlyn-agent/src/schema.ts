/**
 * CAITLYN Agent — Antibody & Antigen Schema
 *
 * Defines TypeScript types matching config.yaml for antibodies and antigens.
 */
// ── Antibody ──────────────────────────────────────────────────────

export interface AntibodyStats {
  total_scans: number;
  true_positives: number;
  false_positives: number;
  avg_latency_us: number;
}

export interface AntibodyConfig {
  id: string;
  name: string;
  parent_id: string | null;
  category: "injection" | "jailbreak" | "poisoning" | "exfiltration";
  tier: 0 | 1 | 2;
  threshold: number;
  description: string;
  affinity_score: number;
  created_at: string;
  generation: number;
  stats: AntibodyStats;
  deps: string[];
  signatures: Array<{ pattern: string; type: string; label: string }>;
}

export interface AntibodyEntry {
  config: AntibodyConfig;
  readme: string;
  scriptPath: string | null; // path to detect.ts, null if tier=1 only
  folderPath: string;
}

// ── Antigen ───────────────────────────────────────────────────────

export interface AntigenConfig {
  id: string;
  name: string;
  category: "injection" | "jailbreak" | "poisoning" | "exfiltration";
  injection_point: string;
  target_agent: string;
  attack_template: string;
  created_at: string;
  parent_id: string | null;
  escapes: string[];
}

export interface AntigenEntry {
  config: AntigenConfig;
  readme: string;
  payload: string;
  folderPath: string;
}

// ── Forest Index ──────────────────────────────────────────────────

export interface TreeNode {
  id: string;
  children: string[];
  stats_aggregated: AntibodyStats;
}

export interface AntibodyIndex {
  roots: string[];
  trees: Record<string, TreeNode>;
}

export interface AntigenIndex {
  entries: Record<string, { id: string; category: string; escapes: string[] }>;
}

// ── Scan Types ────────────────────────────────────────────────────

export type Verdict = "benign" | "suspicious" | "malicious";
export interface ScriptResult {
  antibody_id: string;
  verdict: Verdict;
  confidence: number;
  reason: string | null;
  latency_us: number;
  error: string | null;
}

export interface ScanResult {
  verdict: Verdict;
  confidence: number;
  tier: 0 | 1;
  script_results: ScriptResult[];
  total_latency_us: number;
  total_tokens: number;
}
