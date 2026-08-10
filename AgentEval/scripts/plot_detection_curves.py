#!/usr/bin/env python3
"""
======================================================================
PLOT-DETECTION-CURVES

Render the detection-only sweep results as one figure per dataset with
two panels:
  - left:  ROC curves (TPR vs FPR), AUROC in the legend;
  - right: PR curves (Precision vs Recall), AUPRC in the legend.
Operating points (the default fixed threshold) are marked on both panels.

Also renders a cost-performance Pareto figure using the per-detection
latency and token/cost records saved by run_detection_experiment.py.

Usage:
    python scripts/plot_detection_curves.py \
        --records results/detection_formal/records.jsonl \
        --outdir results/detection_formal/figures

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.ticker import LogLocator, NullLocator  # noqa: E402

DATASETS = ["agentdojo", "aspi", "safeclawbench", "agentdefense"]
DETECTORS = [
    "regex_guard",
    "llm_judge",
    "llm_judge_fewshot",
    "pi_detector",
    "caitlyn",
]
DETECTOR_LABELS = {
    "regex_guard": "Regex-Guard",
    "llm_judge": "LLM-Judge",
    "llm_judge_fewshot": "LLM-Judge+FS",
    "pi_detector": "PI Detector",
    "caitlyn": "CAITLYN",
}
DETECTOR_COLORS = {
    "regex_guard": "#4d4d4d",
    "llm_judge": "#1f77b4",
    "llm_judge_fewshot": "#17becf",
    "pi_detector": "#ff7f0e",
    "caitlyn": "#c1121f",
}
DETECTOR_LINESTYLES = {
    "regex_guard": ":",
    "llm_judge": "-",
    "llm_judge_fewshot": (0, (3, 2)),
    "pi_detector": (0, (5, 2, 1, 2)),
    "caitlyn": "-",
}
DATASET_MARKERS = {
    "agentdojo": "o",
    "aspi": "s",
    "safeclawbench": "^",
    "agentdefense": "v",
}

# OpenRouter deepseek/deepseek-chat prices (USD per token), used only to
# estimate CAITLYN cost because the daemon does not report cost directly.
DS_CHAT_PROMPT = 0.0000002574
DS_CHAT_COMPLETION = 0.0000010287


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    p = argparse.ArgumentParser(description="Plot detection ROC/PR and Pareto")
    p.add_argument("--records", default="results/detection_formal/records.jsonl")
    p.add_argument("--outdir", default="results/detection_formal/figures")
    p.add_argument("--datasets", nargs="+", default=DATASETS)
    return p.parse_args()


def load_records(path: str | Path) -> list[dict]:
    """Load detection records from JSONL."""
    rows = [
        json.loads(line)
        for line in Path(path).read_text(encoding="utf-8").split("\n")
        if line.strip()
    ]
    return rows


def score_of(record: dict) -> float:
    """Extract the continuous score used for threshold curves."""
    score = (record.get("result") or {}).get("score")
    return float(score) if score is not None else 0.0


def blocked_of(record: dict) -> bool:
    """Extract the operating-point verdict."""
    return bool((record.get("result") or {}).get("blocked", False))


def roc_points(
    scores: list[float], labels: list[int]
) -> tuple[list[float], list[float], float]:
    """Return FPR/TPR points and AUROC by sweeping all score thresholds."""
    total_p = sum(labels)
    total_n = len(labels) - total_p
    thresholds = sorted(set(scores), reverse=True) + [float("-inf")]
    fprs: list[float] = []
    tprs: list[float] = []
    for t in thresholds:
        tp = sum(1 for s, l in zip(scores, labels) if l and s >= t)
        fp = sum(1 for s, l in zip(scores, labels) if not l and s >= t)
        tprs.append(tp / total_p if total_p else 0.0)
        fprs.append(fp / total_n if total_n else 0.0)
    auroc = trapezoid_auc(fprs, tprs)
    return fprs, tprs, auroc


def pr_points(
    scores: list[float], labels: list[int]
) -> tuple[list[float], list[float], float]:
    """Return recall/precision points and AUPRC."""
    total_p = sum(labels)
    total_n = len(labels) - total_p
    base_rate = total_p / (total_p + total_n) if (total_p + total_n) else 0.0
    thresholds = sorted(set(scores), reverse=True) + [float("-inf")]
    recalls: list[float] = [0.0]
    precisions: list[float] = [1.0]
    for t in thresholds:
        tp = sum(1 for s, l in zip(scores, labels) if l and s >= t)
        fp = sum(1 for s, l in zip(scores, labels) if not l and s >= t)
        recall = tp / total_p if total_p else 0.0
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        if recall == 0.0 and precision == 0.0:
            # Skip the vertical drop artifact at the highest threshold.
            continue
        recalls.append(recall)
        precisions.append(precision)
    recalls.append(1.0)
    precisions.append(base_rate)
    auprc = trapezoid_auc(recalls, precisions)
    return recalls, precisions, auprc


def trapezoid_auc(xs: list[float], ys: list[float]) -> float:
    """Trapezoidal area under a curve."""
    return sum(
        (xs[i + 1] - xs[i]) * (ys[i] + ys[i + 1]) / 2.0
        for i in range(len(xs) - 1)
    )


def estimate_caitlyn_cost(record: dict) -> float:
    """Estimate CAITLYN USD cost from token count when the daemon omits it."""
    tokens = (record.get("cost") or {}).get("tokens") or 0
    prompt = max(float(tokens) - 1.0, 0.0)
    return prompt * DS_CHAT_PROMPT + 1.0 * DS_CHAT_COMPLETION


def per_detector_arrays(
    records: list[dict], dataset: str
) -> dict[str, dict[str, Any]]:
    """Group scores/labels/operating metrics per detector for one dataset."""
    benign = [r for r in records if r["dataset"] == "shared_benign"]
    out: dict[str, dict[str, Any]] = {}
    for detector in DETECTORS:
        attacks = [
            r for r in records
            if r["dataset"] == dataset
            and r["label"] == "attack"
            and r["detector"] == detector
        ]
        if not attacks:
            continue
        attack_scores = [score_of(r) for r in attacks]
        benign_scores = [score_of(r) for r in benign if r["detector"] == detector]
        labels = [1] * len(attacks) + [0] * len(benign_scores)
        scores = attack_scores + benign_scores
        op_tpr = sum(blocked_of(r) for r in attacks) / len(attacks)
        op_fpr = (
            sum(blocked_of(r) for r in benign if r["detector"] == detector)
            / len(benign_scores)
            if benign_scores else 0.0
        )
        latencies = [
            (r.get("cost") or {}).get("latency_ms")
            for r in attacks
            if (r.get("cost") or {}).get("latency_ms") is not None
        ]
        costs = [
            (r.get("cost") or {}).get("cost_usd")
            if (r.get("cost") or {}).get("cost_usd") is not None
            else estimate_caitlyn_cost(r)
            for r in attacks
        ]
        out[detector] = {
            "scores": scores,
            "labels": labels,
            "op_tpr": op_tpr,
            "op_fpr": op_fpr,
            "op_precision": (
                op_tpr * len(attacks)
                / (
                    op_tpr * len(attacks)
                    + op_fpr * len(benign_scores)
                )
                if (op_tpr * len(attacks) + op_fpr * len(benign_scores)) > 0
                else 0.0
            ),
            "op_recall": op_tpr,
            "avg_latency_ms": (
                sum(latencies) / len(latencies) if latencies else None
            ),
            "avg_cost_usd": sum(costs) / len(costs) if costs else None,
            "n_attacks": len(attacks),
            "n_benign": len(benign_scores),
        }
    return out


def plot_dataset_figure(
    data: dict[str, dict[str, Any]],
    dataset: str,
    out_path: Path,
) -> None:
    """Save one ROC+PR figure per dataset."""
    fig, (ax_roc, ax_pr) = plt.subplots(
        1, 2, figsize=(10.5, 4.2), dpi=200
    )
    for detector, d in data.items():
        fprs, tprs, auroc = roc_points(d["scores"], d["labels"])
        recalls, precisions, auprc = pr_points(d["scores"], d["labels"])
        label = (
            f"{DETECTOR_LABELS[detector]} "
            f"(AUROC {auroc:.3f} / AUPRC {auprc:.3f})"
        )
        ax_roc.plot(
            fprs, tprs, linewidth=1.6, label=label,
            marker="", linestyle="-",
        )
        ax_roc.plot(
            d["op_fpr"], d["op_tpr"], marker="s", markersize=5,
            linestyle="None",
        )
        ax_pr.plot(
            recalls, precisions, linewidth=1.6,
            marker="", linestyle="-",
        )
        ax_pr.plot(
            d["op_recall"], d["op_precision"], marker="s", markersize=5,
            linestyle="None",
        )

    ax_roc.plot([0, 1], [0, 1], color="gray", linewidth=0.8, linestyle="--")
    ax_roc.set_xlabel("False Positive Rate")
    ax_roc.set_ylabel("True Positive Rate")
    ax_roc.set_title(f"{dataset}: ROC")
    ax_roc.set_xlim(-0.02, 1.02)
    ax_roc.set_ylim(-0.02, 1.02)
    ax_roc.grid(alpha=0.3)

    ax_pr.set_xlabel("Recall")
    ax_pr.set_ylabel("Precision")
    ax_pr.set_title(f"{dataset}: PR")
    ax_pr.set_xlim(0.0, 1.02)
    ax_pr.set_ylim(0.0, 1.02)
    ax_pr.grid(alpha=0.3)

    fig.legend(
        loc="lower center", ncol=2, fontsize=7, frameon=False,
        bbox_to_anchor=(0.5, -0.08),
    )
    fig.tight_layout(rect=(0, 0.08, 1, 1))
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


def plot_pareto_figure(
    all_data: dict[str, dict[str, dict[str, Any]]],
    out_path: Path,
) -> None:
    """Save a cost-performance Pareto figure (one panel per dataset)."""
    n = len(all_data)
    fig, axes = plt.subplots(
        1, n, figsize=(3.2 * n, 3.6), dpi=200, squeeze=False
    )
    for ax, (dataset, data) in zip(axes[0], all_data.items()):
        for detector, d in data.items():
            lat = d["avg_latency_ms"]
            cost = d["avg_cost_usd"]
            if lat is None or cost is None:
                continue
            lat = max(lat, 0.01)  # log scale needs a positive value
            ax.scatter(
                lat, d["op_tpr"], s=45, label=DETECTOR_LABELS[detector]
            )
            ax.annotate(
                DETECTOR_LABELS[detector],
                (lat, d["op_tpr"]),
                textcoords="offset points",
                xytext=(6, -6),
                fontsize=7,
            )
        ax.set_xscale("log")
        ax.set_xlabel("Avg Latency (ms)")
        ax.set_ylabel("TPR at default threshold")
        ax.set_title(dataset)
        ax.set_ylim(-0.02, 1.02)
        ax.grid(alpha=0.3)
    fig.legend(
        loc="lower center", ncol=len(DETECTORS), fontsize=7, frameon=False,
        bbox_to_anchor=(0.5, -0.08),
    )
    fig.tight_layout(rect=(0, 0.08, 1, 1))
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


def _style_axes(
    ax: Any,
    xlabel: str,
    ylabel: str,
    xlim: tuple[float, float],
    ylim: tuple[float, float],
    logx: bool = False,
    grid_alpha: float = 0.25,
) -> None:
    """Apply a clean publication style to one panel."""
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    if logx:
        ax.set_xscale("log")
    ax.grid(alpha=grid_alpha, linewidth=0.6)
    ax.tick_params(labelsize=6.5)


def plot_combined_figure(
    all_data: dict[str, dict[str, dict[str, Any]]],
    out_path: Path,
) -> None:
    """Save one publication-quality 2x5 figure (ROC / PR / Pareto)."""
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Liberation Serif", "DejaVu Serif", "Times New Roman"],
        "font.size": 9,
        "axes.titlesize": 9.5,
        "axes.labelsize": 9,
        "legend.fontsize": 8.5,
        "xtick.labelsize": 7.5,
        "ytick.labelsize": 7.5,
    })

    datasets = list(all_data.keys())
    titles = {
        "agentdojo": "AgentDojo-S250",
        "aspi": "ASPI-S",
        "safeclawbench": "SafeClawBench-S240",
        "agentdefense": "AgentDefense-S250",
    }
    letters = "abcdefghij"
    fig, axes = plt.subplots(2, 5, figsize=(16.2, 7.0), dpi=200)

    for i, dataset in enumerate(datasets):
        data = all_data[dataset]
        ax_roc = axes[0, i]
        ax_pr = axes[1, i]
        for detector, d in data.items():
            fprs, tprs, _ = roc_points(d["scores"], d["labels"])
            recalls, precisions, _ = pr_points(d["scores"], d["labels"])
            color = DETECTOR_COLORS[detector]
            linestyle = DETECTOR_LINESTYLES[detector]
            linewidth = 1.6 if detector == "caitlyn" else 1.1
            ax_roc.plot(
                fprs, tprs, color=color, linewidth=linewidth,
                linestyle=linestyle, solid_capstyle="round", zorder=3,
            )
            ax_roc.plot(
                d["op_fpr"], d["op_tpr"], marker="D", markersize=4.2,
                color=color, markerfacecolor=color,
                markeredgecolor="white", markeredgewidth=0.5,
                linestyle="None", zorder=4,
            )
            ax_pr.plot(
                recalls, precisions, color=color, linewidth=linewidth,
                linestyle=linestyle, solid_capstyle="round", zorder=3,
            )
            ax_pr.plot(
                d["op_recall"], d["op_precision"], marker="D", markersize=4.2,
                color=color, markerfacecolor=color,
                markeredgecolor="white", markeredgewidth=0.5,
                linestyle="None", zorder=4,
            )
        ax_roc.plot(
            [0, 1], [0, 1], color="#bbbbbb", linewidth=0.8,
            linestyle="--", zorder=0,
        )
        ax_roc.set_title(
            f"({letters[i]}) {titles[dataset]} ROC",
            fontsize=9.5, fontweight="bold", pad=3,
        )
        ax_pr.set_title(
            f"({letters[5 + i]}) {titles[dataset]} PR",
            fontsize=9.5, fontweight="bold", pad=3,
        )
        _style_axes(ax_roc, "FPR", "TPR", (0.0, 1.0), (0.0, 1.0))
        _style_axes(ax_pr, "Recall", "Precision", (0.0, 1.0), (0.0, 1.0))
        for ax in (ax_roc, ax_pr):
            ax.set_xticks([0.0, 0.25, 0.5, 0.75, 1.0])
            ax.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])

    ax_lat = axes[0, 4]
    ax_cost = axes[1, 4]
    max_cost = 0.0
    dataset_jitter = {
        "agentdojo": -0.035,
        "aspi": -0.012,
        "safeclawbench": 0.012,
        "agentdefense": 0.035,
    }
    for dataset, data in all_data.items():
        marker = DATASET_MARKERS[dataset]
        jitter = dataset_jitter[dataset]
        for detector, d in data.items():
            lat = d["avg_latency_ms"]
            cost = d["avg_cost_usd"]
            if lat is None or cost is None:
                continue
            max_cost = max(max_cost, cost)
            lat_x = max(lat * (1.0 + jitter), 0.01)
            cost_x = (cost + jitter * max_cost) * 1000.0
            ax_lat.scatter(
                lat_x, d["op_tpr"], s=38,
                color=DETECTOR_COLORS[detector], marker=marker,
                edgecolor="white", linewidth=0.5, zorder=3,
            )
            ax_cost.scatter(
                cost_x, d["op_tpr"], s=38,
                color=DETECTOR_COLORS[detector],
                marker=marker, edgecolor="white", linewidth=0.5, zorder=3,
            )
    ax_lat.set_title("(e) Latency Pareto", fontsize=9.5, fontweight="bold", pad=3)
    ax_cost.set_title("(j) Cost Pareto", fontsize=9.5, fontweight="bold", pad=3)
    _style_axes(
        ax_lat, "Avg Latency (ms)", "TPR @ default",
        (0.1, 3.0e4), (-0.02, 1.05), logx=True, grid_alpha=0.15,
    )
    ax_lat.xaxis.set_major_locator(
        LogLocator(base=10, numticks=6)
    )
    ax_lat.xaxis.set_minor_locator(NullLocator())
    _style_axes(
        ax_cost, "Avg Cost ($\\times 10^{-3}$ USD)", "TPR @ default",
        (0.0, max_cost * 1000.0 * 1.1), (-0.02, 1.05), grid_alpha=0.15,
    )
    handles_methods = [
        Line2D(
            [0], [0], color=DETECTOR_COLORS[d],
            linewidth=2.0 if d == "caitlyn" else 1.4,
            linestyle=DETECTOR_LINESTYLES[d],
            label=DETECTOR_LABELS[d],
        )
        for d in DETECTORS
    ]
    dataset_labels = {
        "agentdojo": "AgentDojo-S250",
        "aspi": "ASPI-S",
        "safeclawbench": "SafeClawBench-S240",
        "agentdefense": "AgentDefense-S250",
    }
    handles_datasets = [
        Line2D(
            [0], [0], marker=DATASET_MARKERS[ds], color="none",
            markerfacecolor="#333333", markeredgecolor="#333333",
            markersize=6, linestyle="None", label=dataset_labels[ds],
        )
        for ds in datasets
    ]
    handles = handles_methods + handles_datasets
    fig.legend(
        handles=handles, loc="lower center", ncol=5, frameon=False,
        fontsize=8.5, bbox_to_anchor=(0.5, -0.08),
        columnspacing=1.8, handlelength=2.4, handletextpad=0.6,
        borderaxespad=0.2,
    )
    fig.subplots_adjust(
        wspace=0.34, hspace=0.55, left=0.045,
        right=0.985, top=0.93, bottom=0.24,
    )
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    """Generate ROC/PR figures and the Pareto figure."""
    args = parse_args()
    records = load_records(args.records)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    all_data: dict[str, dict[str, dict[str, Any]]] = {}
    for dataset in args.datasets:
        data = per_detector_arrays(records, dataset)
        all_data[dataset] = data
        if "caitlyn" in data:
            fprs, tprs, auroc = roc_points(
                data["caitlyn"]["scores"], data["caitlyn"]["labels"]
            )
            recalls, precisions, auprc = pr_points(
                data["caitlyn"]["scores"], data["caitlyn"]["labels"]
            )
            print(f"CAITLYN {dataset}: AUROC={auroc:.3f} AUPRC={auprc:.3f}")
        pdf = outdir / f"detection_{dataset}_roc_pr.pdf"
        png = outdir / f"detection_{dataset}_roc_pr.png"
        plot_dataset_figure(data, dataset, pdf)
        plot_dataset_figure(data, dataset, png)
        print(f"saved {pdf} / {png}")

    pareto_pdf = outdir / "detection_pareto.pdf"
    pareto_png = outdir / "detection_pareto.png"
    plot_pareto_figure(all_data, pareto_pdf)
    plot_pareto_figure(all_data, pareto_png)
    print(f"saved {pareto_pdf} / {pareto_png}")

    combined_pdf = outdir / "detection_combined.pdf"
    combined_png = outdir / "detection_combined.png"
    plot_combined_figure(all_data, combined_pdf)
    plot_combined_figure(all_data, combined_png)
    print(f"saved {combined_pdf} / {combined_png}")


if __name__ == "__main__":
    main()
