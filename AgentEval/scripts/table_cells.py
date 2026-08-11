#!/usr/bin/env python3
"""
======================================================================
TABLE-CELLS

Print the per-dataset metrics needed to fill one main-table row from
result files. MCP-native agents report action ASR among delivered
attacks; prompt-delivery agents (pi/hermes/openclaw) have no MCP audit
channel, so the semantic-judge raw ASR is the row's ASR (delivery is
guaranteed by construction).

Usage:
    python3 scripts/table_cells.py results/eval/hermes-none-*.json
    python3 scripts/table_cells.py --json results/eval/hermes-none-*.json

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 11 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_row import summarize  # noqa: E402


def main() -> None:
    """Print one summary line per result file."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()

    rows = []
    for path in args.paths:
        data = json.load(open(path, encoding="utf-8"))
        cfg = data.get("config", {})
        s = summarize(data["results"])
        row = {
            "agent": cfg.get("agent"),
            "defense": cfg.get("defense"),
            "dataset": cfg.get("dataset"),
            "attacks": s["attacks"],
            "benign": s["benign"],
            "delivered": s["delivered"],
            "delivery_rate": round(s["delivery_rate"], 4),
            "raw_asr": round(s["raw_asr"], 4),
            "action_asr": round(s["action_asr"], 4),
            "action_asr_delivered": round(s["action_asr_delivered"], 4),
            "asr_excl_failed": round(s["asr_excl_failed"], 4),
            "failed": s["failed"],
            "fpr": s["fpr"],
            "latency_p50_s": round(s["latency_p50_s"], 2),
            "agent_cost_p50_usd": s["agent_cost_p50_usd"],
        }
        rows.append(row)

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return

    header = (
        "agent defense dataset attacks delivered raw_asr action_asr "
        "asr_delivered fpr lat_p50 cost_p50 failed asr_excl_failed"
    )
    print(header)
    for r in rows:
        fpr = "n/a" if r["fpr"] is None else f"{r['fpr']:.1%}"
        cost = "n/a" if r["agent_cost_p50_usd"] is None else (
            f"{r['agent_cost_p50_usd']:.6f}"
        )
        print(
            f"{r['agent']:<8} {r['defense']:<16} {r['dataset']:<22} "
            f"{r['attacks']:4d} {r['delivered']:4d} "
            f"{r['raw_asr']:.1%} {r['action_asr']:.1%} "
            f"{r['action_asr_delivered']:.1%} {fpr:>6} "
            f"{r['latency_p50_s']:5.1f}s {cost:>9} "
            f"{r['failed']:3d} {r['asr_excl_failed']:.1%}"
        )


if __name__ == "__main__":
    main()
