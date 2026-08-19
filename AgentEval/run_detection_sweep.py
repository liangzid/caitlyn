#!/usr/bin/env python3
"""
======================================================================
RUN-DETECTION-SWEEP

Evaluate CAITLYN's detection stack (Tier-0/Tier-1 via the daemon) against
the AgentDefense-Bench detection subset without running any agent.

Usage:
    python run_detection_sweep.py \
        --attacks ../valsets/eval_subsets/agentdefense_detection_subset.jsonl \
        --benign ../valsets/eval_subsets/agentdefense_benign_subset.jsonl \
        --mode full --limit-attacks 20 --limit-benign 20 \
        --output results/sweep_debug.json

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from agent_eval.security.caitlyn_client import CaitlynClient


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    p = argparse.ArgumentParser(description="CAITLYN detection sweep over AgentDefense-Bench")
    p.add_argument("--attacks", required=True, help="Attack subset JSONL")
    p.add_argument("--benign", required=True, help="Benign subset JSONL")
    p.add_argument("--limit-attacks", type=int, default=0, help="0 = all")
    p.add_argument("--limit-benign", type=int, default=0, help="0 = all")
    p.add_argument(
        "--mode",
        choices=["fast", "full", "merged", "merged-detectors"],
        default="full",
    )
    p.add_argument("--port", type=int, default=9070)
    p.add_argument("--output", default="", help="Output JSON path")
    return p.parse_args()


def extract_content(item: dict) -> str:
    """Extract the scan payload from an AgentDefense-Bench record."""
    if item.get("prompt"):
        return str(item["prompt"])
    for key in ("mcp_request", "request", "payload"):
        if item.get(key):
            return json.dumps(item[key], ensure_ascii=False)
    return ""


def run_sweep(args: argparse.Namespace) -> dict:
    """Scan attacks and benign items, returning aggregated metrics."""
    client = CaitlynClient(port=args.port)
    if not client.health():
        raise SystemExit(f"CAITLYN daemon not reachable on port {args.port}")

    def load(path: str, limit: int) -> list[dict]:
        # Split on "\n" only: splitlines() would also break records that
        # contain Unicode line separators inside JSON strings.
        rows = [json.loads(l) for l in Path(path).read_text(encoding="utf-8").split("\n") if l.strip()]
        return rows[:limit] if limit else rows

    attacks = load(args.attacks, args.limit_attacks)
    benign = load(args.benign, args.limit_benign)
    results: list[dict] = []
    blocked = 0

    for item in attacks:
        verdict = client.scan(extract_content(item), source="mcp_tool_call", mode=args.mode)
        is_blocked = verdict.is_suspicious
        blocked += int(is_blocked)
        results.append({
            "id": item.get("id", ""),
            "source": item.get("source", ""),
            "category": item.get("category", ""),
            "subcategory": item.get("subcategory"),
            "severity": item.get("severity"),
            "source_file": item.get("source_file"),
            "attack_type": item.get("attack_type"),
            "verdict": verdict.verdict,
            "confidence": verdict.confidence,
            "blocked": is_blocked,
            "latency_ms": verdict.latency_ms,
            "tokens": verdict.tokens,
        })

    benign_blocked = 0
    for item in benign:
        verdict = client.scan(extract_content(item), source="mcp_tool_call", mode=args.mode)
        is_blocked = verdict.is_suspicious
        benign_blocked += int(is_blocked)
        results.append({
            "id": item.get("id", ""),
            "source": item.get("source", ""),
            "category": item.get("category", ""),
            "subcategory": item.get("subcategory"),
            "severity": item.get("severity"),
            "source_file": item.get("source_file"),
            "verdict": verdict.verdict,
            "confidence": verdict.confidence,
            "blocked": is_blocked,
            "latency_ms": verdict.latency_ms,
            "tokens": verdict.tokens,
            "is_benign": True,
        })

    per_category = defaultdict(lambda: {"total": 0, "blocked": 0})
    for r in results:
        if r.get("is_benign"):
            continue
        key = r["category"] or "unknown"
        per_category[key]["total"] += 1
        per_category[key]["blocked"] += int(r["blocked"])

    metrics = {
        "attacks": len(attacks),
        "attacks_blocked": blocked,
        "detection_rate": blocked / len(attacks) if attacks else 0.0,
        "benign": len(benign),
        "benign_blocked": benign_blocked,
        "fpr": benign_blocked / len(benign) if benign else 0.0,
        "avg_latency_ms": sum(r["latency_ms"] for r in results) / len(results) if results else 0.0,
        "total_tokens": sum(r["tokens"] for r in results),
        "per_category": dict(per_category),
    }
    return {"config": vars(args), "metrics": metrics, "results": results}


def main() -> None:
    """Run the sweep and print/save the summary."""
    args = parse_args()
    payload = run_sweep(args)
    m = payload["metrics"]
    print(f"attacks={m['attacks']} blocked={m['attacks_blocked']} "
          f"detection_rate={m['detection_rate']:.1%}")
    print(f"benign={m['benign']} blocked={m['benign_blocked']} fpr={m['fpr']:.1%}")
    print(f"avg_latency_ms={m['avg_latency_ms']:.1f} total_tokens={m['total_tokens']}")
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"saved to {out}")


if __name__ == "__main__":
    main()
