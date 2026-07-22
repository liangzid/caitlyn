/**
 * CAITLYN Agent — caitlynd HTTP Client
 *
 * Communicates with the caitlynd daemon's HTTP API.
 */

export interface CaitlyndScanResult {
  verdict: string;
  confidence: number;
  antibody_results: Array<{
    antibody_id: string;
    antibody_name: string;
    verdict: string;
    confidence: number;
    reasoning: string;
  }>;
  matched_memory: Array<any>;
  total_latency_us: number;
  total_tokens: number;
  triggered_vaccination: boolean;
}

export interface CaitlyndStatus {
  version: string;
  active_antibodies: number;
  memory_entries: number;
  tracked_patterns: number;
  total_antibodies?: number;
  uptime_seconds?: number;
}

export class CaitlyndClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async scan(content: string, source: string = "caitlyn-agent"): Promise<CaitlyndScanResult> {
    const response = await fetch(`${this.baseUrl}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, context: { source } }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`caitlynd scan failed (${response.status}): ${text}`);
    }

    return response.json();
  }

  async status(): Promise<CaitlyndStatus> {
    const response = await fetch(`${this.baseUrl}/v1/status`);
    if (!response.ok) {
      throw new Error(`caitlynd status failed (${response.status})`);
    }
    return response.json();
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
