#!/usr/bin/env python3
"""
======================================================================
WATCH-CAITLYN-TABLE1

Wait for the CAITLYN e2e matrix JSON files, then fill Table 1 one
agent at a time. Highlight and rebuild the PDF only after all five
agents have finished.

Usage:
    python3 scripts/watch_caitlyn_table1.py

    Author: [AUTHOR] <[EMAIL]>
    Copyright (C) 2026, [AUTHOR], all rights reserved.
    Created: 20 August 2026
======================================================================
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fill_caitlyn_table1 import (  # noqa: E402
    AGENT_EVAL_ROOT,
    AGENTS,
    agent_jsons_ready,
    EVAL_DIR,
)

LOG = EVAL_DIR / "caitlyn_e2e_matrix.log"
FILL = Path(__file__).resolve().parent / "fill_caitlyn_table1.py"
POLL_S = 60


def matrix_done() -> bool:
    """True when the matrix script printed its terminal marker."""
    if not LOG.exists():
        return False
    return "CAITLYN_MAIN_TABLE_DONE" in LOG.read_text(errors="replace")


def matrix_alive() -> bool:
    """True if the matrix wrapper or a run_benchmark child is running."""
    out = subprocess.run(
        ["pgrep", "-af", "run_caitlyn_main_table|run_matrix.py|run_benchmark.py"],
        capture_output=True,
        text=True,
    )
    lines = [
        ln for ln in out.stdout.splitlines()
        if "watch_caitlyn_table1" not in ln and "pgrep" not in ln
    ]
    return bool(lines)


def fill_one(agent: str) -> None:
    """Attach costs and patch one CAITLYN row into Table 1."""
    cmd = [
        "uv", "run", "python", str(FILL),
        "--agent", agent,
    ]
    print(f"FILL_START {agent}", flush=True)
    subprocess.run(cmd, cwd=str(AGENT_EVAL_ROOT), check=True)
    print(f"FILLED {agent}", flush=True)


def finish_table() -> None:
    """Highlight every agent block and rebuild main.pdf."""
    cmd = [
        "uv", "run", "python", str(FILL),
        "--highlight-only", "--latex",
    ]
    subprocess.run(cmd, cwd=str(AGENT_EVAL_ROOT), check=True)
    print("TABLE1_COMPLETE", flush=True)


def main() -> None:
    """Poll until each agent's three JSONs exist, then fill and highlight."""
    filled: set[str] = set()
    print("WATCH_START", flush=True)
    while True:
        for agent in AGENTS:
            if agent in filled:
                continue
            if agent_jsons_ready(agent):
                fill_one(agent)
                filled.add(agent)
        if len(filled) == len(AGENTS):
            finish_table()
            return
        if matrix_done():
            missing = [a for a in AGENTS if a not in filled]
            raise SystemExit(
                "matrix done but missing agents: " + ", ".join(missing)
            )
        if not matrix_alive() and not matrix_done():
            raise SystemExit(
                "matrix process gone before CAITLYN_MAIN_TABLE_DONE; "
                f"filled={sorted(filled)}"
            )
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
