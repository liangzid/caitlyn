#!/usr/bin/env python3
"""Print CAITLYN vaccination commands for compromised emerging seed cases.

This helper keeps the System II before/after protocol reproducible:
train/vaccinate only on seed-split failures from a before result file, then
evaluate on the full emerging_challenge set and report held-out changes.
"""

from __future__ import annotations

import argparse
import json
import shlex
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
    """Load non-empty JSONL rows as dictionaries."""
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def main() -> None:
    """Print shell-safe vaccination commands for seed failures."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        default="../valsets/emerging_challenge/emerging200.jsonl",
        help="Path to emerging challenge JSONL, relative to AgentEval.",
    )
    parser.add_argument(
        "--before",
        default="results/emerging_simulated_caitlyn_12_v4_fix.json",
        help="Before-result JSON produced by --defense caitlyn.",
    )
    parser.add_argument(
        "--caitlyn-bin",
        default="../caitlyn-agent/caitlyn",
        help="Path to the caitlyn CLI, relative to AgentEval.",
    )
    args = parser.parse_args()

    dataset_path = Path(args.dataset)
    before_path = Path(args.before)
    caitlyn_bin = args.caitlyn_bin

    rows = {row["id"]: row for row in load_jsonl(dataset_path)}
    before = json.loads(before_path.read_text(encoding="utf-8"))
    compromised_ids = {
        result["task_id"]
        for result in before.get("results", [])
        if result.get("compromised")
    }

    seeds = [
        row for row in rows.values()
        if row.get("split") == "seed" and row.get("id") in compromised_ids
    ]
    for row in seeds:
        pattern = row["injected_content"]
        print(f"# {row['id']} ({row['objective_type']})")
        print(f"{shlex.quote(caitlyn_bin)} vaccinate {shlex.quote(pattern)}")


if __name__ == "__main__":
    main()
