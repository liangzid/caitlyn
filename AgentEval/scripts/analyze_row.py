#!/usr/bin/env python3
"""
======================================================================
ANALYZE-ROW

Summarize one agent x defense matrix cell into the metrics needed for
the main table: delivery, action ASR (raw and among delivered), FPR,
latency, and per-subclass breakdowns stored in each result's metadata.

Usage:
    python3 scripts/analyze_row.py results/eval/opencode-none-*.json

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_eval.security.dataset_adapters import attack_delivered  # noqa: E402
from analyze_results import (  # noqa: E402
    action_compromised,
    conservative_compromised,
)


def subclass_key(result: dict) -> str:
    """Pick the canonical fine-grained dimension per dataset."""
    meta = result.get("metadata", {})
    src = result.get("source_dataset", "")
    if src == "agentdojo":
        return meta.get("suite", "unknown")
    if src == "aspi":
        return meta.get("operator", "unknown")
    if src == "safeclawbench":
        return meta.get("attack_type", "unknown")
    return "unknown"


def summarize(results: list[dict]) -> dict:
    """Aggregate one result file into row-level and per-subclass metrics."""
    attacks = [r for r in results if r.get("label") == "injection"]
    benign = [r for r in results if r.get("label") == "benign"]
    n = len(attacks)

    delivered = sum(attack_delivered(r) for r in attacks)
    raw = sum(bool(r.get("compromised")) for r in attacks)
    conservative = sum(
        conservative_compromised(r.get("output", ""), r.get("injected_content", ""))[0]
        for r in attacks
    )
    action = sum(
        action_compromised(r)[0]
        for r in attacks
        if r.get("mcp_tool_calls")
    )
    action_delivered = sum(
        action_compromised(r)[0]
        for r in attacks
        if r.get("mcp_tool_calls") and attack_delivered(r)
    )
    failed = sum(not bool(r.get("success")) for r in attacks)
    asr_excl_failed = sum(
        bool(r.get("compromised"))
        for r in attacks
        if bool(r.get("success"))
    )
    fpr = sum(
        bool(r.get("compromised"))
        or any(c.get("blocked") for c in r.get("mcp_tool_calls", []))
        for r in benign
    )

    durations = [r.get("duration", 0.0) for r in attacks]
    costs = [
        r.get("defense_cost", {}).get("latency_ms", 0.0)
        for r in attacks
    ]
    tokens = [
        r.get("defense_cost", {}).get("tokens", 0)
        for r in attacks
    ]
    agent_costs = [
        (r.get("agent_usage") or {}).get("cost_usd", 0.0)
        for r in attacks
        if (r.get("agent_usage") or {}).get("cost_usd") is not None
    ]

    per_subclass: dict[str, dict] = defaultdict(
        lambda: {"total": 0, "delivered": 0, "raw": 0, "action": 0}
    )
    for r in attacks:
        key = subclass_key(r)
        per_subclass[key]["total"] += 1
        per_subclass[key]["delivered"] += int(attack_delivered(r))
        per_subclass[key]["raw"] += int(bool(r.get("compromised")))
        if r.get("mcp_tool_calls"):
            per_subclass[key]["action"] += int(action_compromised(r)[0])

    return {
        "attacks": n,
        "benign": len(benign),
        "delivered": delivered,
        "delivery_rate": delivered / n if n else 0.0,
        "raw_asr": raw / n if n else 0.0,
        "conservative_asr": conservative / n if n else 0.0,
        "action_asr": action / n if n else 0.0,
        "action_asr_delivered": (
            action_delivered / delivered if delivered else 0.0
        ),
        "failed": failed,
        "asr_excl_failed": (
            asr_excl_failed / (n - failed) if n > failed else 0.0
        ),
        "fpr": fpr / len(benign) if benign else None,
        "latency_p50_s": statistics.median(durations) if durations else 0.0,
        "defense_latency_p50_ms": statistics.median(costs) if costs else 0.0,
        "defense_tokens_p50": statistics.median(tokens) if tokens else 0,
        "agent_cost_p50_usd": (
            statistics.median(agent_costs) if agent_costs else None
        ),
        "agent_cost_median_usd": (
            statistics.median(agent_costs) if agent_costs else None
        ),
        "agent_usage_count": len(agent_costs),
        "per_subclass": {
            k: {
                "total": v["total"],
                "delivered": v["delivered"],
                "raw_asr": v["raw"] / v["total"] if v["total"] else 0.0,
                "action_asr": v["action"] / v["total"] if v["total"] else 0.0,
            }
            for k, v in sorted(per_subclass.items())
        },
    }


def main() -> None:
    """Print a compact summary for every result file."""
    for path in sys.argv[1:]:
        data = json.load(open(path, encoding="utf-8"))
        s = summarize(data["results"])
        fpr_str = "n/a" if s["fpr"] is None else f"{s['fpr']:.1%}"
        print(f"== {path}")
        print(
            f"  attacks={s['attacks']} delivered={s['delivered']} "
            f"delivery={s['delivery_rate']:.1%} "
            f"raw ASR={s['raw_asr']:.1%} "
            f"action ASR={s['action_asr']:.1%} "
            f"action ASR(delivered)={s['action_asr_delivered']:.1%} "
            f"FPR={fpr_str} "
            f"lat p50={s['latency_p50_s']:.1f}s"
            f" agent$ p50={s['agent_cost_p50_usd']}"
        )
        for k, v in s["per_subclass"].items():
            print(
                f"    {k:12s} n={v['total']:3d} del={v['delivered']:3d} "
                f"raw={v['raw_asr']:.0%} action={v['action_asr']:.0%}"
            )


if __name__ == "__main__":
    main()
