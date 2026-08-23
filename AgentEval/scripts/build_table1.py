#!/usr/bin/env python3
"""
======================================================================
BUILD-TABLE1

Regenerate every row of Table 1 (main end-to-end effectiveness) from the
finished per-cell JSON files under results/eval, then mark best
(textbf) and second-best (underline) cells inside each agent block.

Metric mapping matches the agreed Table 1 protocol:
  - opencode AgentDojo/ASPI use action ASR over all attacks;
  - every other agent/dataset cell uses raw (semantic-judge) ASR;
  - FPR is per-dataset benign controls (n/a for SafeClawBench);
  - Latency is p50 seconds per attack; Cost is median agent USD.

Usage:
    python3 scripts/build_table1.py --latex

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 21 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_row import summarize  # noqa: E402

AGENT_EVAL_ROOT = Path(__file__).resolve().parent.parent
EVAL_DIR = AGENT_EVAL_ROOT / "results" / "eval"
PAPER_TABLE = Path("/home/zi/paper_caitlyn/sections/tables/table-main.tex")
PAPER_DIR = Path("/home/zi/paper_caitlyn")

DATASETS = (
    "agentdojo_subset",
    "aspi_subset",
    "safeclawbench_subset",
)
AGENTS = ("opencode", "codex", "pi", "hermes", "openclaw")
AGENT_MARKERS = {
    "opencode": r"opencode\(^\dagger\)",
    "codex": r"codex\(^\ddagger\)",
    "pi": r"pi\(^\ddagger\)",
    "hermes": r"hermes\(^\ddagger\)",
    "openclaw": r"openclaw\(^\S\)",
}

# Table row order and the defense slug used in result file names.
DEFENSES = (
    ("None", "none"),
    ("Regex-Guard\\(^{*}\\)", "regex_guard"),
    ("LLM-Judge\\(^{*}\\)", "llm_judge"),
    ("LLM-Judge+Fewshot\\(^{*}\\)", "llm_judge_fewshot"),
    ("Spotlighting+Delimiting \\cite{agentdojo}", "spotlighting"),
    ("Tool Filter \\cite{agentdojo}", "tool_filter"),
    ("PI Detector \\cite{agentdojo,protectaideberta}", "pi_detector"),
    ("CAITLYN (ours)", "caitlyn"),
)

# opencode AgentDojo uses action ASR (tool-channel audit). ASPI reports
# semantic-judge raw ASR for every agent because the opencode agent does
# not reliably issue tool calls under the full-prompt ASPI protocol, so
# action ASR would be 0.0% for all defenses and carry no signal.
MCP_ACTION_ASR = {
    ("opencode", "agentdojo_subset"),
}


def json_path(agent: str, defense: str, dataset: str) -> Path:
    """Return the result JSON path for one cell."""
    return EVAL_DIR / f"{agent}-{defense}-{dataset}.json"


def load_summary(agent: str, defense: str, dataset: str) -> dict | None:
    """Load summarize() from withcost JSON when present, else raw JSON."""
    path = json_path(agent, defense, dataset)
    withcost = Path(str(path) + ".withcost.json")
    if withcost.exists():
        path = withcost
    if not path.exists():
        return None
    data = json.load(open(path, encoding="utf-8"))
    return summarize(data["results"])


def pct(value: float) -> str:
    """Format a rate as a one-decimal LaTeX percent cell."""
    return f"{100.0 * value:.1f}\\%"


def format_cells(agent: str, defense: str) -> list[str]:
    """Build the 12 Table 1 cells for one agent x defense row."""
    cells: list[str] = []
    for dataset in DATASETS:
        s = load_summary(agent, defense, dataset)
        if s is None:
            cells += ["--", "--", "--", "--"]
            continue
        asr = (
            s["action_asr"]
            if (agent, dataset) in MCP_ACTION_ASR
            else s["raw_asr"]
        )
        cells.append(pct(asr))
        cells.append("n/a" if s["fpr"] is None else pct(s["fpr"]))
        cells.append(f"{s['latency_p50_s']:.1f}")
        cost = s["agent_cost_p50_usd"]
        cells.append("--" if cost is None else f"{cost:.4f}")
    return cells


def bare_cell(cell: str) -> str:
    """Strip best/second-best wrappers so re-runs stay idempotent."""
    s = cell.strip()
    while True:
        if s.startswith("\\textbf{") and s.endswith("}"):
            s = s[len("\\textbf{"):-1]
            continue
        if s.startswith("\\underline{") and s.endswith("}"):
            s = s[len("\\underline{"):-1]
            continue
        break
    return s


def cell_number(cell: str) -> float | None:
    """Parse a table cell into a float, or None for n/a and placeholders."""
    s = bare_cell(cell)
    if s in ("n/a", "--", ""):
        return None
    return float(s.replace("\\%", "").replace("%", ""))


def wrap_cell(cell: str, kind: str) -> str:
    """Wrap a bare cell as best (textbf) or second-best (underline)."""
    inner = bare_cell(cell)
    if kind == "textbf":
        return f"\\textbf{{{inner}}}"
    return f"\\underline{{{inner}}}"


def mark_column(raw: list[str]) -> list[str]:
    """Bold the minimum and underline the next distinct value."""
    present = [(i, cell_number(c)) for i, c in enumerate(raw)]
    present = [(i, n) for i, n in present if n is not None]
    out = [bare_cell(c) for c in raw]
    if not present:
        return out
    best = min(n for _, n in present)
    rest = [n for _, n in present if n != best]
    second = min(rest) if rest else None
    for i, n in present:
        if n == best:
            out[i] = wrap_cell(out[i], "textbf")
        elif second is not None and n == second:
            out[i] = wrap_cell(out[i], "underline")
    return out


def render_row(agent: str, defense_label: str, defense_slug: str) -> str:
    """Render one defense row line for one agent block."""
    cells = format_cells(agent, defense_slug)
    if defense_slug == "caitlyn":
        prefix = "      \\rowcolor{BoxGray} & CAITLYN (ours) & "
    else:
        prefix = f"      & {defense_label} & "
    return prefix + " & ".join(cells) + r" \\"


def build_body() -> str:
    """Build the full tabular body (rows only) for Table 1."""
    lines: list[str] = []
    for agent in AGENTS:
        lines.append(f"    \\multirow{{8}}{{*}}{{{AGENT_MARKERS[agent]}}}")
        raw_rows = [
            format_cells(agent, slug) for _, slug in DEFENSES
        ]
        marked: list[list[str]] = []
        for col in range(12):
            marked.append(mark_column([row[col] for row in raw_rows]))
        for (label, slug), row in zip(DEFENSES, range(8)):
            cells = [marked[c][row] for c in range(12)]
            if slug == "caitlyn":
                prefix = "      \\rowcolor{BoxGray} & CAITLYN (ours) & "
            else:
                prefix = f"      & {label} & "
            lines.append(prefix + " & ".join(cells) + r" \\")
        lines.append("    \\midrule")
    # Remove the trailing midrule after the last agent block.
    if lines and lines[-1].strip() == "\\midrule":
        lines.pop()
    return "\n".join(lines) + "\n"


def patch_latex() -> None:
    """Replace the tabular body between the header and bottomrule."""
    text = PAPER_TABLE.read_text(encoding="utf-8")
    # Restrict the edit to the FIRST tabular (Table 1). The marker search
    # starts after the first \begin{tabular} so a later table (e.g. the
    # LLM API table) can never be captured by the replacement window.
    tabular = text.find("\\begin{tabular}")
    start = text.find("    \\midrule\n", tabular)
    if start < 0:
        raise RuntimeError("Table 1 first midrule not found")
    end = text.find("    \\bottomrule", start)
    if end < 0:
        raise RuntimeError("Table 1 bottomrule not found")
    new_text = text[: start + len("    \\midrule\n")] + build_body() + text[end:]
    if "Shaded rows are CAITLYN" in text and "Shaded rows are CAITLYN" not in new_text:
        raise RuntimeError("build_table1 would drop the Table 1 footnote; aborting")
    PAPER_TABLE.write_text(new_text, encoding="utf-8")


def rebuild_pdf() -> None:
    """Rebuild main.pdf with latexmk."""
    subprocess.run(
        ["latexmk", "-pdf", "-interaction=nonstopmode", "main.tex"],
        cwd=str(PAPER_DIR),
        check=False,
    )


def main() -> None:
    """Regenerate Table 1 and optionally rebuild the PDF."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latex", action="store_true")
    args = parser.parse_args()
    missing: list[str] = []
    for agent in AGENTS:
        for _, defense in DEFENSES:
            for dataset in DATASETS:
                if not json_path(agent, defense, dataset).exists():
                    missing.append(f"{agent}-{defense}-{dataset}")
    if missing:
        print("MISSING", len(missing))
        for m in missing:
            print(" ", m)
        raise SystemExit(1)
    patch_latex()
    print("TABLE1_BUILT")
    if args.latex:
        rebuild_pdf()
        print("TABLE1_PDF_REBUILT")


if __name__ == "__main__":
    main()
