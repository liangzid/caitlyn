"""
======================================================================
SUMMARIZE-SYSTEM-I-ABLATION

Print TPR / FPR / latency / USD for every System I ablation variant
under one output root.

    Author: [AUTHOR] <[EMAIL]>
    Copyright (C) 2026, [AUTHOR], all rights reserved.
    Created: 20 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

VARIANTS = [
    "t0-only",
    "none",
    "ensemble",
    "merged",
    "merged-detectors",
    "full",
]
DATASETS = ["agentdojo", "aspi", "safeclawbench", "agentdefense"]


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    p = argparse.ArgumentParser(description="Summarize System I ablation dirs")
    p.add_argument("--root", required=True, help="Ablation output root")
    return p.parse_args()


def pct(value: float | None) -> str:
    """Format a rate as a percentage string."""
    if value is None:
        return "--"
    return f"{100.0 * value:.1f}"


def main() -> None:
    """Print one row per variant, one column group per dataset."""
    args = parse_args()
    root = Path(args.root)
    print(
        f"{'variant':<18} "
        + " ".join(f"{d:>22}" for d in DATASETS)
    )
    print(
        f"{'':18} "
        + " ".join(f"{'TPR/FPR  ms  USD':>22}" for _ in DATASETS)
    )
    for variant in VARIANTS:
        summary_path = root / variant / "summary.json"
        if not summary_path.exists():
            print(f"{variant:<18} MISSING")
            continue
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
        cells = payload.get("summary", payload)
        parts = [f"{variant:<18}"]
        for dataset in DATASETS:
            cell = cells.get(dataset, {}).get("caitlyn", {})
            tpr = pct(cell.get("tpr"))
            fpr = pct(cell.get("fpr"))
            lat = cell.get("avg_latency_ms")
            usd = cell.get("avg_cost_usd")
            lat_s = f"{lat:.0f}" if isinstance(lat, (int, float)) else "--"
            usd_s = f"{usd:.5f}" if isinstance(usd, (int, float)) else "--"
            parts.append(f"{tpr}/{fpr} {lat_s:>5} {usd_s:>8}".rjust(22))
        print(" ".join(parts))


if __name__ == "__main__":
    main()
