#!/usr/bin/env python3
"""
======================================================================
ATTACH-HERMES-COST

Normalize the per-case hermes usage report (captured at runtime through
the HermesCaller --usage-file hook) into the same agent_usage schema as
opencode and pi, so the main table's Cost column can be computed from
any result file uniformly.

Usage:
    python3 scripts/attach_hermes_cost.py results/eval/hermes-none-*.json

Writes <input>.withcost.json next to each input.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 11 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def normalize(raw: dict | None) -> dict | None:
    """Map hermes usage-file fields to the standard agent_usage schema."""
    if not raw:
        return None
    return {
        "session_id": raw.get("session_id"),
        "cost_usd": float(raw.get("estimated_cost_usd", 0.0) or 0.0),
        "tokens_input": int(raw.get("input_tokens", 0) or 0),
        "tokens_output": int(raw.get("output_tokens", 0) or 0),
        "tokens_reasoning": int(raw.get("reasoning_tokens", 0) or 0),
        "tokens_cache_read": int(raw.get("cache_read_tokens", 0) or 0),
        "tokens_cache_write": int(raw.get("cache_write_tokens", 0) or 0),
        "tokens_total": int(raw.get("total_tokens", 0) or 0),
        "api_calls": int(raw.get("api_calls", 0) or 0),
        "model": raw.get("model"),
        "provider": raw.get("provider"),
        "completed": raw.get("completed"),
        "failed": raw.get("failed"),
        "raw": raw,
    }


def attach(path: str) -> dict:
    """Enrich every result record with normalized hermes usage."""
    data = json.load(open(path, encoding="utf-8"))
    matched = unmatched = 0
    for r in data["results"]:
        usage = normalize(r.get("agent_usage"))
        if usage is None:
            unmatched += 1
            continue
        r["agent_usage"] = usage
        matched += 1

    out_path = Path(path + ".withcost.json")
    out_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"path": path, "matched": matched, "unmatched": unmatched}


def main() -> None:
    """Normalize usage for every result file and print a summary."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()
    for p in args.paths:
        if not p.endswith(".json") or p.endswith(".withcost.json"):
            continue
        summary = attach(p)
        print(
            f"{summary['path']}: matched={summary['matched']} "
            f"unmatched={summary['unmatched']}"
        )


if __name__ == "__main__":
    main()
