#!/usr/bin/env python3
"""
======================================================================
PLOT-LIFELONG-SYNTHESIS

Sequential two-line figure and a three-row endpoint table for paper 5.2.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 22 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", "/tmp/caitlyn-matplotlib")

import matplotlib.pyplot as plt

FAMILY_LABELS = {
    "status_field": "status",
    "freshness_framing": "freshness",
    "policy_delta": "policy",
    "search_mirror": "mirror",
    "latest_event": "event",
    "directory_alias": "alias",
    "ledger_update": "ledger",
    "mail_followup": "mail",
    "operational_command": "command",
}


def read_jsonl(path: Path) -> list[dict]:
    """Load JSONL rows."""
    rows = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.strip():
            rows.append(json.loads(line))
    return rows


def sequential_metrics_path(run_dir: Path) -> Path:
    """Prefer the 5.1-pruned replay when it exists."""
    pruned = run_dir / "sequential_pruned" / "metrics.jsonl"
    if pruned.is_file():
        return pruned
    return run_dir / "sequential" / "metrics.jsonl"


def load_metrics(run_dir: Path) -> list[dict]:
    """Load sequential per-wave metrics (pruned replay if present)."""
    path = sequential_metrics_path(run_dir)
    return read_jsonl(path) if path.is_file() else []


def overall_from_wave_metrics(last: dict) -> tuple[float, int]:
    """Combine current and earlier held-out TPR at the last wave."""
    seq_tpr = last["current_heldout_tpr"]
    seq_n = last["current_heldout_n"]
    if last["previous_heldout_tpr"] is None:
        return seq_tpr, seq_n
    prev_n = last["previous_heldout_n"]
    hits = last["current_heldout_tpr"] * last["current_heldout_n"]
    hits += last["previous_heldout_tpr"] * prev_n
    seq_n = last["current_heldout_n"] + prev_n
    return (hits / seq_n if seq_n else 0.0), seq_n


def plot_sequential(metrics: list[dict], out_pdf: Path, out_png: Path) -> None:
    """Draw current-family TPR and previous-family mean TPR."""
    waves = [row["wave"] for row in metrics]
    current = [100.0 * float(row["current_heldout_tpr"]) for row in metrics]
    previous = [
        None if row["previous_heldout_tpr"] is None else 100.0 * float(row["previous_heldout_tpr"])
        for row in metrics
    ]
    labels = [FAMILY_LABELS.get(row["family"], row["family"]) for row in metrics]

    fig, ax = plt.subplots(figsize=(7.2, 2.6))
    ax.plot(waves, current, marker="o", color="#0072B2", label="Current family held-out TPR")
    prev_x = [w for w, v in zip(waves, previous) if v is not None]
    prev_y = [v for v in previous if v is not None]
    if prev_x:
        ax.plot(prev_x, prev_y, marker="s", color="#D55E00", label="Earlier families held-out TPR")
    ax.set_xticks(waves, labels, rotation=25, ha="right")
    ax.set_ylabel("TPR (%)")
    ax.set_ylim(-5, 105)
    ax.set_xlabel("Wave")
    ax.legend(frameon=False, loc="upper left")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_pdf)
    fig.savefig(out_png, dpi=200)
    plt.close(fig)


def endpoint_row(name: str, tpr: float, n: int, fpr: float, skills: int, tokens: int) -> dict:
    """One table row."""
    return {
        "method": name,
        "heldout_tpr": tpr,
        "heldout_n": n,
        "fpr": fpr,
        "active_skills": skills,
        "tokens": tokens,
    }


def sequential_tokens(run_dir: Path) -> int:
    """Sum synthesis tokens across wave outcomes."""
    total = 0
    waves_dir = run_dir / "sequential" / "waves"
    if not waves_dir.is_dir():
        return 0
    for path in sorted(waves_dir.glob("*/outcome.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        total += int(data.get("tokensUsed") or 0)
    return total


def write_table(rows: list[dict], out_json: Path, out_tex: Path) -> None:
    """Write JSON and a compact LaTeX table."""
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    lines = [
        r"\begin{tabular}{lcccc}",
        r"\toprule",
        r"Method & Held-out TPR & FPR & Skills & Tokens \\",
        r"\midrule",
    ]
    for row in rows:
        lines.append(
            f"{row['method']} & {100 * row['heldout_tpr']:.1f}\\% & "
            f"{100 * row['fpr']:.1f}\\% & {row['active_skills']} & "
            f"{row['tokens']} \\\\"
        )
    lines.extend([r"\bottomrule", r"\end{tabular}", ""])
    out_tex.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    """Plot the sequential curve and emit the endpoint table if all three methods exist."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--run-dir",
        default="results/lifelong_paper_20260822",
    )
    args = parser.parse_args()
    run_dir = Path(args.run_dir).resolve()
    metrics = load_metrics(run_dir)
    if not metrics:
        raise SystemExit(f"no sequential metrics in {run_dir}")
    figures = run_dir / "figures"
    plot_sequential(
        metrics,
        figures / "lifelong_sequential.pdf",
        figures / "lifelong_sequential.png",
    )
    unpruned_path = run_dir / "sequential" / "metrics.jsonl"
    if unpruned_path.is_file() and sequential_metrics_path(run_dir) != unpruned_path:
        plot_sequential(
            read_jsonl(unpruned_path),
            figures / "lifelong_sequential_unpruned.pdf",
            figures / "lifelong_sequential_unpruned.png",
        )

    table_rows: list[dict] = []
    static_eval = run_dir / "static" / "eval.json"
    batch_eval = run_dir / "batch" / "eval.json"
    last = metrics[-1]
    if static_eval.is_file():
        data = json.loads(static_eval.read_text(encoding="utf-8"))
        table_rows.append(
            endpoint_row("Static", data["overall_heldout_tpr"], data["overall_heldout_n"], data["fpr"], 0, 0)
        )
    if batch_eval.is_file():
        data = json.loads(batch_eval.read_text(encoding="utf-8"))
        tokens = int((data.get("outcome") or {}).get("tokensUsed") or 0)
        table_rows.append(
            endpoint_row(
                "Batch",
                data["overall_heldout_tpr"],
                data["overall_heldout_n"],
                data["fpr"],
                data["active_skills"],
                tokens,
            )
        )
    pruned_eval = run_dir / "sequential_pruned" / "eval.json"
    if pruned_eval.is_file():
        data = json.loads(pruned_eval.read_text(encoding="utf-8"))
        seq_tpr = data["overall_heldout_tpr"]
        seq_n = data["overall_heldout_n"]
        seq_fpr = data["fpr"]
        seq_skills = data["active_skills"]
    else:
        seq_tpr, seq_n = overall_from_wave_metrics(last)
        seq_fpr = last["fpr"]
        seq_skills = last["active_skills"]
    table_rows.append(
        endpoint_row(
            "Sequential",
            seq_tpr,
            seq_n,
            seq_fpr,
            seq_skills,
            sequential_tokens(run_dir),
        )
    )
    write_table(table_rows, run_dir / "endpoint_table.json", run_dir / "endpoint_table.tex")
    if pruned_eval.is_file() and unpruned_path.is_file():
        unpruned_last = read_jsonl(unpruned_path)[-1]
        unpruned_tpr, unpruned_n = overall_from_wave_metrics(unpruned_last)
        unpruned_rows = list(table_rows[:-1]) + [
            endpoint_row(
                "Sequential-unpruned",
                unpruned_tpr,
                unpruned_n,
                unpruned_last["fpr"],
                unpruned_last["active_skills"],
                sequential_tokens(run_dir),
            )
        ]
        write_table(
            unpruned_rows,
            run_dir / "endpoint_table_unpruned.json",
            run_dir / "endpoint_table_unpruned.tex",
        )
    print(f"wrote {figures / 'lifelong_sequential.pdf'}")
    print(json.dumps(table_rows, indent=2))


if __name__ == "__main__":
    main()
