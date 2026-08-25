#!/usr/bin/env python3
"""
======================================================================
MERGE-DETECTION-RUNS

Merge a new CAITLYN-only detection run with a previous full run, keeping
the unchanged detectors (regex / llm_judge / llm_judge_fewshot /
pi_detector) from the base run and replacing only the CAITLYN records.

Usage:
    python scripts/merge_detection_runs.py \
        --base results/detection_formal_20260811_v5/records.jsonl \
        --override results/detection_caitlyn_20260813/records.jsonl \
        --output results/detection_merged_20260813

    Author: [AUTHOR] <[EMAIL]>
    Copyright (C) 2026, [AUTHOR], all rights reserved.
    Created: 13 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from run_detection_experiment import summarize  # noqa: E402


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    p = argparse.ArgumentParser(description="Merge detection runs")
    p.add_argument("--base", required=True, help="Base full-run records.jsonl")
    p.add_argument("--override", required=True, help="New CAITLYN records.jsonl")
    p.add_argument("--output", required=True, help="Output directory")
    return p.parse_args()


def load_records(path: str | Path) -> list[dict]:
    """Load JSONL records."""
    return [
        json.loads(line)
        for line in Path(path).read_text(encoding="utf-8").split("\n")
        if line.strip()
    ]


def main() -> None:
    """Merge and write records.jsonl + summary.json."""
    args = parse_args()
    base = load_records(args.base)
    override = load_records(args.override)

    base_others = [r for r in base if r["detector"] != "caitlyn"]
    caitlyn = [r for r in override if r["detector"] == "caitlyn"]
    if not caitlyn:
        raise SystemExit("override file has no CAITLYN records")

    merged = base_others + caitlyn
    outdir = Path(args.output)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "records.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in merged),
        encoding="utf-8",
    )
    summary = summarize(merged)
    (outdir / "summary.json").write_text(
        json.dumps({"summary": summary}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"merged {len(merged)} records -> {outdir / 'records.jsonl'}")
    for dataset, cells in summary.items():
        if "caitlyn" not in cells:
            continue
        c = cells["caitlyn"]
        tpr = f"{c['tpr']:.3f}" if c["tpr"] is not None else "n/a"
        fpr = f"{c['fpr']:.3f}" if c["fpr"] is not None else "n/a"
        print(f"  {dataset}: CAITLYN TPR={tpr} FPR={fpr}")


if __name__ == "__main__":
    main()
