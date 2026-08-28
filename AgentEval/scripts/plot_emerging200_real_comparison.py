#!/usr/bin/env python3
"""Plot Emerging200 real-agent ASR comparison.

The figure uses one panel per real agent and highlights the evolved CAITLYN
result against all static baselines.
"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", "/tmp/caitlyn-matplotlib")

import matplotlib.pyplot as plt
import numpy as np


AGENTS = ["openclaw", "codex", "hermes"]
AGENT_TITLES = {
    "openclaw": "OpenClaw",
    "codex": "Codex",
    "hermes": "Hermes",
}
DEFENSES = [
    ("none", "None"),
    ("regex_guard", "Regex-Guard*"),
    ("llm_judge", "LLM-Judge*"),
    ("llm_judge_fewshot", "LLM-Judge+Fewshot*"),
    ("spotlighting", "Spotlighting+Delimiting"),
    ("tool_filter", "Tool Filter"),
    ("pi_detector", "PI Detector"),
    ("caitlyn", "CAITLYN-static"),
    (
        "caitlyn_evolved_after_pruned_promptfiltered",
        "CAITLYN-evolved",
    ),
]
EVOLVED_KEY = "caitlyn_evolved_after_pruned_promptfiltered"


def result_path(results_dir: Path, agent: str, defense_key: str) -> Path:
    """Return the result path for one agent-defense pair."""
    if defense_key == EVOLVED_KEY:
        return (
            results_dir
            / f"emerging200_real_{agent}_caitlyn_evolved_after_pruned_promptfiltered.json"
        )
    return results_dir / f"emerging200_real_{agent}_{defense_key}.json"


def summarize_result(path: Path) -> dict[str, float | int]:
    """Load one result JSON and summarize ASR, errors, and defense events."""
    data = json.loads(path.read_text(encoding="utf-8"))
    results = data.get("results", [])
    total = len(results)
    compromised = sum(bool(r.get("compromised")) for r in results)
    errors = sum(bool(r.get("error")) for r in results)
    blocked = 0
    events = 0
    for r in results:
        cost = r.get("defense_cost") or {}
        blocked += int(cost.get("blocked") or 0)
        events += len(cost.get("events") or [])
    return {
        "total": total,
        "compromised": compromised,
        "asr": compromised / total if total else 0.0,
        "errors": errors,
        "blocked": blocked,
        "events": events,
    }


def collect_rows(results_dir: Path) -> list[dict[str, str | float | int]]:
    """Collect all configured result files into table rows."""
    rows: list[dict[str, str | float | int]] = []
    for agent in AGENTS:
        for defense_key, defense_label in DEFENSES:
            summary = summarize_result(result_path(results_dir, agent, defense_key))
            rows.append({
                "agent": agent,
                "defense_key": defense_key,
                "defense": defense_label.replace("\n", " "),
                **summary,
            })
    return rows


def write_csv(rows: list[dict[str, str | float | int]], output_path: Path) -> None:
    """Write the summarized table to CSV."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "agent",
        "defense_key",
        "defense",
        "total",
        "compromised",
        "asr",
        "errors",
        "blocked",
        "events",
    ]
    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def values_for_agent(
    rows: list[dict[str, str | float | int]], agent: str
) -> dict[str, dict[str, str | float | int]]:
    """Index rows for one agent by defense key."""
    return {
        str(r["defense_key"]): r
        for r in rows
        if r["agent"] == agent
    }


def plot_asr_grouped(rows: list[dict[str, str | float | int]], output_base: Path) -> None:
    """Plot ASR with agents on the x-axis and defenses in the legend."""
    output_base.parent.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "axes.titlesize": 14,
        "axes.labelsize": 12,
        "xtick.labelsize": 11,
        "ytick.labelsize": 10,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })

    keys = [key for key, _ in DEFENSES]
    labels = [label for _, label in DEFENSES]
    x = np.arange(len(AGENTS))
    bar_width = 0.085
    offsets = (np.arange(len(keys)) - (len(keys) - 1) / 2) * bar_width
    colors = [
        "#CBD5E1",
        "#A7B4C6",
        "#8EA0B8",
        "#7890AD",
        "#7BA7A2",
        "#C2A46D",
        "#9E8FB8",
        "#4B5563",
        "#D81B60",
    ]
    static_color = "#4B5563"
    evolved_color = "#D81B60"
    edge_color = "#1F2937"

    fig, ax = plt.subplots(figsize=(10.4, 4.45))
    by_agent = {agent: values_for_agent(rows, agent) for agent in AGENTS}

    for idx, (key, label) in enumerate(zip(keys, labels, strict=True)):
        values = [
            float(by_agent[agent][key]["asr"]) * 100.0
            for agent in AGENTS
        ]
        bars = ax.bar(
            x + offsets[idx],
            values,
            width=bar_width * 0.92,
            label=label,
            color=colors[idx],
            edgecolor=edge_color,
            linewidth=0.55,
            zorder=3,
        )
        if key == EVOLVED_KEY:
            for bar, value in zip(bars, values, strict=True):
                ax.text(
                    bar.get_x() + bar.get_width() / 2,
                    value + 1.2,
                    f"{value:.1f}",
                    ha="center",
                    va="bottom",
                    fontsize=9,
                    fontweight="bold",
                    color=evolved_color,
                )
        elif key == "caitlyn":
            for bar, value in zip(bars, values, strict=True):
                ax.text(
                    bar.get_x() + bar.get_width() / 2,
                    value + 1.2,
                    f"{value:.1f}",
                    ha="center",
                    va="bottom",
                    fontsize=8,
                    fontweight="bold",
                    color=static_color,
                )
    static_idx = keys.index("caitlyn")
    evolved_idx = keys.index(EVOLVED_KEY)
    for agent_idx, agent in enumerate(AGENTS):
        static_value = float(by_agent[agent]["caitlyn"]["asr"]) * 100.0
        evolved_value = float(by_agent[agent][EVOLVED_KEY]["asr"]) * 100.0
        drop = static_value - evolved_value
        static_x = x[agent_idx] + offsets[static_idx]
        evolved_x = x[agent_idx] + offsets[evolved_idx]
        ax.annotate(
            f"-{drop:.1f} pts",
            xy=(evolved_x, evolved_value + 2.5),
            xytext=(static_x + 0.04, min(88.0, static_value + 7.0)),
            arrowprops={
                "arrowstyle": "->",
                "color": evolved_color,
                "lw": 1.25,
                "shrinkA": 2,
                "shrinkB": 2,
            },
            color=evolved_color,
            fontsize=10,
            fontweight="bold",
            ha="center",
            zorder=5,
        )

    ax.set_title("Emerging Benchmark Agent Evaluation", fontweight="bold", pad=16)
    ax.set_ylabel("ASR (%)", fontweight="bold")
    ax.set_ylim(0, 94)
    ax.set_xticks(x)
    ax.set_xticklabels([AGENT_TITLES[a] for a in AGENTS], fontweight="bold")
    ax.grid(axis="y", color="#E5E7EB", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#9CA3AF")
    ax.spines["bottom"].set_color("#9CA3AF")
    ax.legend(
        loc="upper center",
        bbox_to_anchor=(0.5, -0.12),
        ncol=5,
        frameon=False,
        fontsize=10,
        handlelength=1.6,
        columnspacing=1.0,
        labelspacing=0.55,
    )
    fig.subplots_adjust(left=0.085, right=0.995, bottom=0.28, top=0.88)
    fig.savefig(output_base.with_suffix(".pdf"), bbox_inches="tight")
    fig.savefig(output_base.with_suffix(".svg"), bbox_inches="tight")
    fig.savefig(output_base.with_suffix(".png"), bbox_inches="tight", dpi=300)
    plt.close(fig)


def main() -> None:
    """Generate the CSV and figure artifacts."""
    root = Path(__file__).resolve().parents[1]
    output_base = root / "figures" / "emerging200_real_asr_comparison_panels"
    rows = collect_rows(root / "results")
    write_csv(rows, root / "figures" / "emerging200_real_asr_comparison.csv")
    plot_asr_grouped(rows, output_base)
    print("Wrote figures/emerging200_real_asr_comparison_panels.pdf")
    print("Wrote figures/emerging200_real_asr_comparison_panels.svg")
    print("Wrote figures/emerging200_real_asr_comparison_panels.png")
    print("Wrote figures/emerging200_real_asr_comparison.csv")


if __name__ == "__main__":
    main()
