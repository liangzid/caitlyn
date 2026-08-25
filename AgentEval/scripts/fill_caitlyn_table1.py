#!/usr/bin/env python3
"""
======================================================================
FILL-CAITLYN-TABLE1

Fill the five CAITLYN rows in Table 1 from finished e2e JSON files,
then mark the best (bold) and second-best (underline) cell in each
agent block, per numeric column. Lower is better for every metric.

ASR mapping matches the already-filled baseline rows, not the caption:
  opencode AgentDojo/ASPI use action_asr over all attacks
  opencode SafeClawBench and every other agent use raw_asr (judge)

Usage:
    python3 scripts/fill_caitlyn_table1.py --agent opencode
    python3 scripts/fill_caitlyn_table1.py --all --latex

    Author: [AUTHOR] <[EMAIL]>
    Copyright (C) 2026, [AUTHOR], all rights reserved.
    Created: 20 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
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
# Table 1 row order.
AGENTS = ("opencode", "codex", "pi", "hermes", "openclaw")
# KEYPOINT: opencode AD/ASPI cells were filled with action_asr, not
# action_asr_delivered. Do not "fix" this to match the caption.
MCP_ACTION_ASR = {
    ("opencode", "agentdojo_subset"),
    ("opencode", "aspi_subset"),
}
CST = timezone(timedelta(hours=8))
# Matrix started 2026-08-20 16:10 CST. Window starts a few minutes early.
CAITLYN_E2E_START_MS = int(
    datetime(2026, 8, 20, 16, 0, tzinfo=CST).timestamp() * 1000
)
# openclaw CAITLYN cell started 2026-08-21 06:59 CST.
OPENCLAW_CAITLYN_START_S = datetime(
    2026, 8, 21, 6, 50, tzinfo=CST
).timestamp()
ATTACH = {
    "opencode": [
        "uv", "run", "python", "scripts/attach_agent_cost.py",
        "--start-ms", str(CAITLYN_E2E_START_MS),
    ],
    "pi": ["uv", "run", "python", "scripts/attach_pi_cost.py"],
    "hermes": ["uv", "run", "python", "scripts/attach_hermes_cost.py"],
    "openclaw": [
        "uv", "run", "python", "scripts/attach_openclaw_cost.py",
        "--since-epoch", str(OPENCLAW_CAITLYN_START_S),
    ],
    "codex": ["uv", "run", "python", "scripts/attach_codex_cost.py"],
}


def json_path(agent: str, dataset: str) -> Path:
    """Return the finished result JSON for one agent x dataset cell."""
    return EVAL_DIR / f"{agent}-caitlyn-{dataset}.json"


def withcost_path(agent: str, dataset: str) -> Path:
    """Return the cost-enriched sibling of a result JSON."""
    return Path(str(json_path(agent, dataset)) + ".withcost.json")


def load_summary(agent: str, dataset: str) -> dict:
    """Load summarize() from withcost JSON when present, else raw JSON."""
    path = withcost_path(agent, dataset)
    if not path.exists():
        path = json_path(agent, dataset)
    data = json.load(open(path, encoding="utf-8"))
    return summarize(data["results"])


def pct(value: float) -> str:
    """Format a rate as a one-decimal LaTeX percent cell."""
    return f"{100.0 * value:.1f}\\%"


def format_cells(agent: str) -> list[str]:
    """Build the 12 Table 1 cells for one CAITLYN row."""
    cells: list[str] = []
    for dataset in DATASETS:
        s = load_summary(agent, dataset)
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


def agent_jsons_ready(agent: str) -> bool:
    """True when all three dataset JSONs for this agent exist."""
    return all(json_path(agent, ds).exists() for ds in DATASETS)


def attach_costs(agent: str) -> None:
    """Run the agent-specific cost attacher on finished CAITLYN JSONs.

    opencode.db was truncated after the run (disk I/O error, 4 KiB empty
    file). Codex wrote no session dirs on 2026-08-20/21. Do not join
    those rows to older baseline sessions.
    """
    if agent in ("opencode", "codex"):
        print(f"ATTACH_SKIP {agent}: no contemporary session store", flush=True)
        return
    paths = [str(json_path(agent, ds)) for ds in DATASETS]
    cmd = ATTACH[agent] + paths
    print("ATTACH", " ".join(cmd), flush=True)
    result = subprocess.run(cmd, cwd=str(AGENT_EVAL_ROOT))
    if result.returncode != 0:
        print(f"ATTACH_FAIL {agent} rc={result.returncode}", flush=True)


def patch_caitlyn_row(text: str, agent: str, cells: list[str]) -> str:
    """Replace the CAITLYN placeholder row inside one agent block."""
    marker = f"\\multirow{{8}}{{*}}{{{agent}"
    idx = text.find(marker)
    if idx < 0:
        raise RuntimeError(f"agent block not found: {agent}")
    caitlyn = text.find("& CAITLYN (ours) &", idx)
    if caitlyn < 0:
        raise RuntimeError(f"CAITLYN row not found for {agent}")
    line_end = text.find("\n", caitlyn)
    line_start = text.rfind("\n", 0, caitlyn) + 1
    new_line = (
        "      \\rowcolor{BoxGray} & CAITLYN (ours) & "
        + " & ".join(cells)
        + r" \\"
    )
    return text[:line_start] + new_line + text[line_end:]


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


def mark_one_column(raw_cells: list[str]) -> list[str]:
    """Bold the minimum and underline the next distinct value."""
    nums = [(i, cell_number(c)) for i, c in enumerate(raw_cells)]
    present = [(i, n) for i, n in nums if n is not None]
    out = [bare_cell(c) for c in raw_cells]
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


def data_row_indices(lines: list[str], start: int) -> list[int]:
    """Collect the eight defense rows that follow a multirow agent marker."""
    rows: list[int] = []
    i = start
    while i < len(lines) and len(rows) < 8:
        stripped = lines[i].rstrip()
        if " & " in lines[i] and stripped.endswith(r"\\"):
            rows.append(i)
        i += 1
    if len(rows) != 8:
        raise RuntimeError(f"expected 8 defense rows at line {start + 1}")
    return rows


def highlight_table1(text: str) -> str:
    """Mark best/second-best inside each Table 1 agent block."""
    begin = text.find("\\label{tab:main-effectiveness}")
    end = text.find("\\end{tabular}", begin)
    if begin < 0 or end < 0:
        raise RuntimeError("Table 1 tabular not found")
    head, body, tail = text[:begin], text[begin:end], text[end:]
    lines = body.splitlines(keepends=True)
    starts = [i for i, ln in enumerate(lines) if r"\multirow{8}" in ln]
    for start in starts:
        idxs = data_row_indices(lines, start)
        parsed = [_split_data_row(lines[i]) for i in idxs]
        n_cols = len(parsed[0][1])
        marked_cols = [
            mark_one_column([parts[c] for _, parts in parsed])
            for c in range(n_cols)
        ]
        for row_i, (prefix, _parts) in enumerate(parsed):
            new_parts = [marked_cols[c][row_i] for c in range(n_cols)]
            lines[idxs[row_i]] = prefix + " & ".join(new_parts) + r" \\" + "\n"
    return head + "".join(lines) + tail


def _split_data_row(line: str) -> tuple[str, list[str]]:
    """Split a defense row into the leading ' & ' prefix and metric cells."""
    body = line.rstrip()
    if body.endswith(r"\\"):
        body = body[:-2].rstrip()
    parts = body.split(" & ")
    # parts[0] is indent / rowcolor, parts[1] is the defense name.
    prefix = parts[0] + " & " + parts[1] + " & "
    return prefix, parts[2:]


def write_table(text: str) -> None:
    """Overwrite the paper Table 1 source."""
    PAPER_TABLE.write_text(text, encoding="utf-8")


def rebuild_pdf() -> None:
    """Rebuild main.pdf with latexmk."""
    subprocess.run(
        ["latexmk", "-pdf", "-interaction=nonstopmode", "main.tex"],
        cwd=str(PAPER_DIR),
        check=True,
    )


def fill_agent(agent: str, attach: bool) -> list[str]:
    """Attach cost if requested, then return the 12 CAITLYN cells."""
    if not agent_jsons_ready(agent):
        missing = [
            str(json_path(agent, ds))
            for ds in DATASETS
            if not json_path(agent, ds).exists()
        ]
        raise FileNotFoundError("missing: " + ", ".join(missing))
    if attach:
        attach_costs(agent)
    cells = format_cells(agent)
    print(f"CELLS {agent}: {' | '.join(cells)}", flush=True)
    return cells


def parse_args() -> argparse.Namespace:
    """Parse CLI flags for incremental or full Table 1 fill."""
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--agent", choices=AGENTS)
    p.add_argument("--all", action="store_true")
    p.add_argument("--no-attach", action="store_true")
    p.add_argument("--highlight-only", action="store_true")
    p.add_argument("--latex", action="store_true")
    return p.parse_args()


def main() -> None:
    """Fill requested CAITLYN rows, then optionally highlight and compile."""
    args = parse_args()
    text = PAPER_TABLE.read_text(encoding="utf-8")
    if args.highlight_only:
        write_table(highlight_table1(text))
        print("HIGHLIGHT_DONE", flush=True)
        if args.latex:
            rebuild_pdf()
        return
    targets = list(AGENTS) if args.all else ([args.agent] if args.agent else [])
    if not targets:
        raise SystemExit("pass --agent NAME or --all")
    for agent in targets:
        cells = fill_agent(agent, attach=not args.no_attach)
        text = patch_caitlyn_row(text, agent, cells)
    if args.all or len(targets) == len(AGENTS):
        text = highlight_table1(text)
        print("HIGHLIGHT_DONE", flush=True)
    write_table(text)
    if args.latex:
        rebuild_pdf()
        print("TABLE1_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
