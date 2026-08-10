#!/usr/bin/env python3
"""
======================================================================
DUMP-AGENTDOJO-INJECTIONS

Materialize the real injected surface texts for the AgentDojo v1 subset
using the official package (attack template: important_instructions).

This script must run inside the agentdojo environment (the repo's own
venv at /tmp/agentdata/agentdojo/.venv). It reads the stratified subset
produced by build_eval_subsets.py and writes, for every pair, the
dictionary of injected surfaces produced by the official attack.

Run (from the agentdojo repo checkout):
    .venv/bin/python /home/zi/caitlyn/AgentEval/scripts/dump_agentdojo_injections.py

Output: valsets/eval_subsets/agentdojo_subset_injections.jsonl
    one JSONL record per (suite, user_task_id, injection_task_id):
    {"suite", "user_task_id", "injection_task_id", "attack", "surfaces"}
======================================================================
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from agentdojo.attacks import load_attack
from agentdojo.task_suite.load_suites import get_suites

ROOT = Path(__file__).resolve().parent.parent.parent
SUBSET_PATH = ROOT / "valsets" / "eval_subsets" / "agentdojo_subset.jsonl"
OUT_PATH = ROOT / "valsets" / "eval_subsets" / "agentdojo_subset_injections.jsonl"
ATTACK_NAME = "important_instructions"


class DummyPipeline:
    """Minimal pipeline object satisfying the attack API (name only)."""

    name = "gpt-4o-2024-05-13"


def main() -> None:
    """Dump injected surfaces for every subset pair."""
    subset = [
        json.loads(line)
        for line in SUBSET_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    suites = get_suites("v1")
    written = skipped = 0

    with OUT_PATH.open("w", encoding="utf-8") as out:
        for row in subset:
            suite = suites[row["suite"]]
            user_task = suite.get_user_task_by_id(row["user_task_id"])
            injection_task = suite.get_injection_task_by_id(row["injection_task_id"])
            attack = load_attack(ATTACK_NAME, suite, DummyPipeline())
            try:
                surfaces = attack.attack(user_task, injection_task)
            except Exception as exc:  # noqa: BLE001 - a pair may be uninjectable
                print(f"skip {row['suite']} {row['user_task_id']} "
                      f"{row['injection_task_id']}: {type(exc).__name__}: {exc}")
                skipped += 1
                continue
            out.write(json.dumps({
                "suite": row["suite"],
                "user_task_id": row["user_task_id"],
                "injection_task_id": row["injection_task_id"],
                "attack": ATTACK_NAME,
                "surfaces": surfaces,
            }, ensure_ascii=False) + "\n")
            written += 1

    print(f"written={written} skipped={skipped} -> {OUT_PATH}")


if __name__ == "__main__":
    main()
