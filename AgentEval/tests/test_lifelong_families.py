"""
======================================================================
TEST-LIFELONG-FAMILIES

Every Emerging-200 row must land in one of the nine frozen waves.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 22 August 2026
======================================================================
"""

from __future__ import annotations

from pathlib import Path

from agent_eval.security.dataset_adapters import _read_jsonl
from agent_eval.security.lifelong_families import (
    WAVE_ORDER,
    group_emerging_rows,
    split_seed_heldout,
)

ROOT = Path(__file__).resolve().parents[2]
EMERGING = ROOT / "valsets" / "emerging_challenge" / "emerging200.jsonl"


def test_all_emerging_rows_map_to_nine_waves() -> None:
    """200 rows, nine non-empty families, each with seed and heldout."""
    rows = _read_jsonl(EMERGING)
    assert len(rows) == 200
    grouped = group_emerging_rows(rows)
    assert list(grouped) == WAVE_ORDER
    assert sum(len(family_rows) for family_rows in grouped.values()) == 200
    for family_rows in grouped.values():
        seed, heldout = split_seed_heldout(family_rows)
        assert seed
        assert heldout
