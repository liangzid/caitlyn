#!/usr/bin/env python3
"""
======================================================================
RUN-MATRIX

Run one agent x defense cell of the main evaluation matrix across the
three agentic datasets (AgentDojo-S250, ASPI-S, SafeClawBench-S240).
Each dataset writes its own result JSON under results/eval/.

Usage:
    PYTHONPATH=src python3 run_matrix.py \
        --agent opencode --defense none --model deepseek/deepseek-chat

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Dataset -> extra CLI arguments (sample caps and benign counts).
DATASET_ARGS = {
    "agentdojo_subset": ("--max-attacks", "250", "--max-benign", "97"),
    "aspi_subset": ("--max-attacks", "31"),
    "safeclawbench_subset": ("--max-attacks", "240"),
}


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    p = argparse.ArgumentParser(description="Run one agent x defense matrix cell")
    p.add_argument("--agent", required=True, help="Agent id (e.g. opencode)")
    p.add_argument("--defense", default="none")
    p.add_argument("--model", default="deepseek/deepseek-chat")
    p.add_argument("--datasets", nargs="+", default=list(DATASET_ARGS))
    p.add_argument("--mcp-port", type=int, default=9877)
    p.add_argument("--timeout", type=int, default=180)
    p.add_argument("--outdir", default="results/eval")
    return p.parse_args()


def main() -> None:
    """Run the benchmark for every requested dataset, sequentially."""
    args = parse_args()
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONPATH="src")

    for dataset in args.datasets:
        out = outdir / f"{args.agent}-{args.defense}-{dataset}.json"
        cmd = [
            sys.executable, "run_benchmark.py",
            "--agent", args.agent,
            "--defense", args.defense,
            "--dataset", dataset,
            "--model", args.model,
            "--timeout", str(args.timeout),
            "--mcp-port", str(args.mcp_port),
            "--output", str(out),
            *DATASET_ARGS[dataset],
        ]
        print("RUN " + " ".join(cmd), flush=True)
        rc = subprocess.call(cmd, env=env)
        if rc != 0:
            print(f"FAILED {dataset} rc={rc}", flush=True)
            sys.exit(rc)
    print("MATRIX_CELL_DONE", flush=True)


if __name__ == "__main__":
    main()
