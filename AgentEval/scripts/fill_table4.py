#!/usr/bin/env python3
"""
======================================================================
FILL-TABLE4

Fill Table 4 (LLM backbone comparison) from OpenCode x CAITLYN
SafeClawBench-S240 result files. ASR is the semantic-judge raw ASR.
Utility is the safe-behavior judge rate.

Usage:
    python3 scripts/fill_table4.py
    python3 scripts/fill_table4.py --latex

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 20 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_row import summarize  # noqa: E402

EVAL_DIR = Path(__file__).resolve().parent.parent / "results" / "eval" / "table4"
PAPER_TABLE = Path("/home/zi/paper_caitlyn/sections/tables/table-llm-api.tex")
PAPER_DIR = Path("/home/zi/paper_caitlyn")

# KEYPOINT: display name -> model id used by run_benchmark.
# OpenRouter rows use bare slugs; the AICodeMirror relay rows use the
# provider-qualified ids configured in the container's opencode.jsonc.
MODELS = (
    ("DeepSeek-V4-Flash", "deepseek/deepseek-v4-flash-0731"),
    ("Qwen3.8-Max", "qwen/qwen3.8-max"),
    ("GLM-5.3", "z-ai/glm-5.3"),
    ("Kimi-K3", "moonshotai/kimi-k3"),
    ("MiniMax-M3", "minimax/minimax-m3"),
    ("Claude-Opus-4.6", "aicodemirror-claude/claude-opus-4-6"),
    ("Claude-Fable-5", "aicodemirror-claude/claude-fable-5"),
    ("GPT-5.6-Sol", "aicodemirror/gpt-5.6-sol"),
    ("Gemini-3.5-Flash", "aicodemirror-gemini/gemini-3.5-flash"),
    ("Gemini-3.7-Flash", "aicodemirror-gemini/gemini-3.7-flash"),
)


def slug_tag(model: str) -> str:
    """Turn an OpenRouter slug into a filesystem-safe tag."""
    return model.replace("/", "__")


def result_path(model: str) -> Path:
    """Return the Table 4 result JSON for one backbone."""
    return EVAL_DIR / f"opencode-caitlyn-safeclawbench-{slug_tag(model)}.json"


def withcost_path(model: str) -> Path:
    """Return the cost-enriched sibling JSON."""
    return Path(str(result_path(model)) + ".withcost.json")


def load_summary(model: str) -> dict | None:
    """Load summarize() from withcost JSON when present."""
    path = withcost_path(model)
    if not path.exists():
        path = result_path(model)
    if not path.exists():
        return None
    data = json.load(open(path, encoding="utf-8"))
    return summarize(data["results"])


def pct(value: float) -> str:
    """Format a rate as a one-decimal LaTeX percent cell."""
    return f"{100.0 * value:.1f}\\%"


def format_row(display: str, model: str) -> str | None:
    """Build one latex table row, or None if the JSON is missing."""
    s = load_summary(model)
    if s is None:
        return None
    util = "n/a" if s["utility"] is None else pct(s["utility"])
    cost = s["agent_cost_p50_usd"]
    cost_s = "--" if cost is None else f"{cost:.4f}"
    return (
        f"    {display} & {pct(s['raw_asr'])} & {util} & "
        f"{s['latency_p50_s']:.1f} & {cost_s} \\\\"
    )


def patch_latex() -> int:
    """Replace filled model rows in table-main.tex. Return patched count."""
    text = PAPER_TABLE.read_text(encoding="utf-8")
    patched = 0
    for display, model in MODELS:
        row = format_row(display, model)
        if row is None:
            continue
        # Overwrite the whole model row whether it is a placeholder or an
        # earlier protocol's numbers, so a protocol rerun stays consistent.
        pattern = rf"^    {re.escape(display)} & .*? \\\\$"
        # Lambda replacement: re.sub interprets backslashes in a string
        # replacement, which would collapse the LaTeX row terminator.
        new_text, n = re.subn(
            pattern, lambda _m: row, text, count=1, flags=re.MULTILINE
        )
        if n != 1:
            print(f"SKIP {display}: latex row not found", flush=True)
            continue
        text = new_text
        patched += 1
        print(f"PATCH {display}", flush=True)
    PAPER_TABLE.write_text(text, encoding="utf-8")
    return patched


def rebuild_pdf() -> None:
    """Rebuild main.pdf in the paper repo."""
    subprocess.run(
        ["latexmk", "-pdf", "-interaction=nonstopmode", "main.tex"],
        cwd=PAPER_DIR,
        check=False,
    )


def main() -> None:
    """Print and optionally patch Table 4 rows."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latex", action="store_true")
    args = parser.parse_args()
    for display, model in MODELS:
        row = format_row(display, model)
        print(row or f"    {display} & -- & -- & -- & --  % missing")
    if args.latex:
        n = patch_latex()
        if n:
            rebuild_pdf()
        print(f"PATCHED {n}", flush=True)


if __name__ == "__main__":
    main()
