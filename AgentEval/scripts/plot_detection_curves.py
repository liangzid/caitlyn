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
import math
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
    "regex_guard": "-",
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
OP_MARKERS = {
    "regex_guard": "o",
    "llm_judge": "s",
    "llm_judge_fewshot": "^",
    "pi_detector": "v",
    "caitlyn": "D",
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


def spread_points(
    points: list[tuple[float, float]],
    min_dx: float = 0.03,
    min_dy: float = 0.03,
    max_r: float = 0.18,
) -> list[tuple[float, float]]:
    """Move overlapping markers apart with a deterministic outward spiral."""
    placed: list[tuple[float, float]] = []
    result: list[tuple[float, float]] = []
    for x, y in points:
        candidates: list[tuple[float, float]] = [(x, y)]
        step = 1
        while step * min_dx <= max_r:
            for dx, dy in (
                (step * min_dx, 0.0),
                (-step * min_dx, 0.0),
                (0.0, step * min_dy),
                (0.0, -step * min_dy),
                (step * min_dx, step * min_dy),
                (-step * min_dx, step * min_dy),
                (step * min_dx, -step * min_dy),
                (-step * min_dx, -step * min_dy),
            ):
                candidates.append((x + dx, y + dy))
            step += 1
        chosen = None
        for cand in candidates:
            if all(
                abs(cand[0] - px) >= min_dx or abs(cand[1] - py) >= min_dy
                for px, py in placed
            ):
                chosen = cand
                break
        if chosen is None:
            chosen = (x, y)
        placed.append(chosen)
        result.append(chosen)
    return result


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
    ylabel_pad: float = 6.0,
) -> None:
    """Apply a clean publication style to one panel."""
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel, labelpad=ylabel_pad)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    if logx:
        ax.set_xscale("log")
    ax.grid(alpha=grid_alpha, linewidth=0.6)
    ax.tick_params(labelsize=12.5)


def plot_combined_figure(
    all_data: dict[str, dict[str, dict[str, Any]]],
    out_path: Path,
) -> None:
    """Save one publication-quality 2x5 figure (ROC / PR / Pareto)."""
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Liberation Serif", "DejaVu Serif", "Times New Roman"],
        "font.size": 15,
        "axes.titlesize": 14,
        "axes.labelsize": 15,
        "legend.fontsize": 14,
        "xtick.labelsize": 14,
        "ytick.labelsize": 14,
    })

    datasets = list(all_data.keys())
    titles = {
        "agentdojo": "AgentDojo",
        "aspi": "ASPI-S",
        "safeclawbench": "SafeClawBench",
        "agentdefense": "AgentDefense",
    }
    letters = "abcdefghij"
    fig, axes = plt.subplots(2, 5, figsize=(9.5, 4.6), dpi=200)

    for i, dataset in enumerate(datasets):
        data = all_data[dataset]
        ax_roc = axes[0, i]
        ax_pr = axes[1, i]
        for detector, d in data.items():
            fprs, tprs, auroc = roc_points(d["scores"], d["labels"])
            recalls, precisions, auprc = pr_points(d["scores"], d["labels"])
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
            f"({letters[i]}) {titles[dataset]}",
            fontsize=15.5, fontweight="bold", pad=5,
        )
        ax_pr.set_title(
            f"({letters[5 + i]}) {titles[dataset]}",
            fontsize=15.5, fontweight="bold", pad=5,
        )
        _style_axes(ax_roc, "FPR", "TPR", (-0.02, 1.02), (-0.02, 1.06))
        _style_axes(ax_pr, "Recall", "Precision", (-0.02, 1.02), (-0.02, 1.06))
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
                lat_x, d["op_tpr"], s=40,
                color=DETECTOR_COLORS[detector], marker=marker,
                edgecolor="white", linewidth=0.5, zorder=3,
            )
            ax_cost.scatter(
                cost_x, d["op_tpr"], s=40,
                color=DETECTOR_COLORS[detector],
                marker=marker, edgecolor="white", linewidth=0.5, zorder=3,
            )
    ax_lat.set_title(
        "(e) Latency", fontsize=15.5, fontweight="bold", pad=5
    )
    ax_cost.set_title(
        "(j) Cost", fontsize=15.5, fontweight="bold", pad=5
    )
    _style_axes(
        ax_lat, "Avg Latency (ms)", "TPR at default",
        (0.1, 3.0e4), (-0.02, 1.05), logx=True, grid_alpha=0.15,
    )
    ax_lat.xaxis.set_major_locator(
        LogLocator(base=10, numticks=6)
    )
    ax_lat.xaxis.set_minor_locator(NullLocator())
    _style_axes(
        ax_cost, "Avg Cost ($\\times 10^{-3}$ USD)", "TPR at default",
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
            markersize=9, linestyle="None", label=dataset_labels[ds],
        )
        for ds in datasets
    ]
    handles = handles_methods + handles_datasets
    fig.legend(
        handles=handles, loc="upper center", ncol=4, frameon=False,
        fontsize=14.5, bbox_to_anchor=(0.5, 1.0),
        columnspacing=2.0, handlelength=2.6, handletextpad=0.7,
        borderaxespad=0.2, labelspacing=0.5, handleheight=2.2,
    )
    fig.text(
        0.012, 0.66, "ROC", rotation=90, va="center", ha="center",
        fontsize=15, fontweight="bold",
    )
    fig.text(
        0.012, 0.29, "PR", rotation=90, va="center", ha="center",
        fontsize=15, fontweight="bold",
    )
    fig.subplots_adjust(
        wspace=0.50, hspace=0.42, left=0.085,
        right=0.985, top=0.80, bottom=0.10,
    )
    fig.savefig(out_path, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def plot_roc_pr_grid(
    all_data: dict[str, dict[str, dict[str, Any]]],
    out_path: Path,
) -> None:
    """Save the main 2x4 ROC/PR figure with large, print-ready fonts."""
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Liberation Serif", "DejaVu Serif", "Times New Roman"],
        "font.size": 12.5,
        "axes.titlesize": 12.5,
        "axes.labelsize": 12.5,
        "legend.fontsize": 11.5,
        "xtick.labelsize": 12,
        "ytick.labelsize": 12,
    })

    datasets = list(all_data.keys())
    titles = {
        "agentdojo": "AgentDojo",
        "aspi": "ASPI-S",
        "safeclawbench": "SafeClawBench",
        "agentdefense": "AgentDefense",
    }
    letters = "abcdefgh"
    fig, axes = plt.subplots(2, 4, figsize=(10.0, 4.8), dpi=200)
    for i, dataset in enumerate(datasets):
        data = all_data[dataset]
        ax_roc = axes[0, i]
        ax_pr = axes[1, i]
        for detector, d in data.items():
            fprs, tprs, _ = roc_points(d["scores"], d["labels"])
            recalls, precisions, _ = pr_points(d["scores"], d["labels"])
            color = DETECTOR_COLORS[detector]
            linestyle = DETECTOR_LINESTYLES[detector]
            linewidth = 1.7 if detector == "caitlyn" else 1.2
            ax_roc.plot(
                fprs, tprs, color=color, linewidth=linewidth,
                linestyle=linestyle, solid_capstyle="round", zorder=3,
            )
            ax_pr.plot(
                recalls, precisions, color=color, linewidth=linewidth,
                linestyle=linestyle, solid_capstyle="round", zorder=3,
            )
        detector_order = [det for det in DETECTORS if det in data]
        roc_ops = spread_points(
            [(data[det]["op_fpr"], data[det]["op_tpr"])
             for det in detector_order],
            min_dx=0.12, min_dy=0.10, max_r=1.00,
        )
        pr_ops = spread_points(
            [(data[det]["op_recall"], data[det]["op_precision"])
             for det in detector_order],
            min_dx=0.12, min_dy=0.10, max_r=1.00,
        )
        for det, (x, y) in zip(detector_order, roc_ops):
            face = (
                "white"
                if det in ("regex_guard", "llm_judge")
                else DETECTOR_COLORS[det]
            )
            ax_roc.plot(
                x, y, marker=OP_MARKERS[det], markersize=6.0,
                color=DETECTOR_COLORS[det],
                markerfacecolor=face,
                markeredgecolor=DETECTOR_COLORS[det], markeredgewidth=1.2,
                linestyle="None", zorder=4,
            )
        for det, (x, y) in zip(detector_order, pr_ops):
            alpha = 1.0 if det == "caitlyn" else 0.65
            face = (
                "white"
                if det in ("regex_guard", "llm_judge")
                else DETECTOR_COLORS[det]
            )
            ax_pr.plot(
                x, y, marker=OP_MARKERS[det],
                markersize=7.0 if det == "caitlyn" else 5.5,
                color=DETECTOR_COLORS[det],
                markerfacecolor=face,
                markeredgecolor=DETECTOR_COLORS[det], markeredgewidth=1.2,
                alpha=alpha,
                linestyle="None", zorder=4,
            )
        ax_roc.plot(
            [0, 1], [0, 1], color="#bbbbbb", linewidth=1.0,
            linestyle="--", zorder=0,
        )
        ax_roc.set_title(
            f"({letters[i]}) {titles[dataset]}",
            fontsize=12.5, fontweight="bold", pad=8,
        )
        ax_pr.set_title(
            f"({letters[4 + i]}) {titles[dataset]}",
            fontsize=12.5, fontweight="bold", pad=8,
        )
        _style_axes(ax_roc, "FPR", "TPR", (-0.08, 1.12), (-0.10, 1.20))
        _style_axes(ax_pr, "Recall", "Precision", (-0.08, 1.12), (-0.10, 1.20))
        for ax in (ax_roc, ax_pr):
            ax.set_xticks([0.0, 0.25, 0.5, 0.75, 1.0])
            ax.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])

    handles_methods = [
        Line2D(
            [0], [0], color=DETECTOR_COLORS[d],
            linewidth=2.2 if d == "caitlyn" else 1.5,
            linestyle=DETECTOR_LINESTYLES[d],
            marker=OP_MARKERS[d],
            markerfacecolor=(
                "white"
                if d in ("regex_guard", "llm_judge")
                else DETECTOR_COLORS[d]
            ),
            markeredgecolor=DETECTOR_COLORS[d], markeredgewidth=1.2,
            markersize=8,
            label=DETECTOR_LABELS[d],
        )
        for d in DETECTORS
    ]
    fig.legend(
        handles=handles_methods,
        loc="lower center", ncol=5, frameon=False,
        fontsize=11, bbox_to_anchor=(0.5, -0.10),
        columnspacing=1.8, handlelength=2.0, handletextpad=0.6,
        borderaxespad=0.3, handleheight=1.8,
    )
    fig.text(
        0.02, 0.66, "ROC", rotation=90, va="center", ha="center",
        fontsize=12.5, fontweight="bold",
    )
    fig.text(
        0.02, 0.29, "PR", rotation=90, va="center", ha="center",
        fontsize=12.5, fontweight="bold",
    )
    fig.subplots_adjust(
        wspace=0.75, hspace=1.2, left=0.16,
        right=0.985, top=0.95, bottom=0.23,
    )
    fig.savefig(out_path, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def plot_pareto_grid(
    all_data: dict[str, dict[str, dict[str, Any]]],
    out_path: Path,
) -> None:
    """Save the 1x2 latency/cost Pareto figure with large fonts."""
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Liberation Serif", "DejaVu Serif", "Times New Roman"],
        "font.size": 12.5,
        "axes.titlesize": 12.5,
        "axes.labelsize": 12.5,
        "legend.fontsize": 11.5,
        "xtick.labelsize": 12,
        "ytick.labelsize": 12,
    })
    fig, (ax_lat, ax_cost) = plt.subplots(
        1, 2, figsize=(10.0, 3.5), dpi=200
    )
    max_cost = 0.0
    dataset_jitter = {
        "agentdojo": 0.35,
        "aspi": 0.65,
        "safeclawbench": 1.1,
        "agentdefense": 1.7,
    }
    dataset_cost_jitter = {
        "agentdojo": 0.03,
        "aspi": 0.11,
        "safeclawbench": 0.22,
        "agentdefense": 0.36,
    }
    dataset_y_jitter = {
        "agentdojo": -0.09,
        "aspi": -0.03,
        "safeclawbench": 0.03,
        "agentdefense": 0.09,
    }
    lat_items: list[tuple[float, float, str, str]] = []
    cost_items: list[tuple[float, float, str, str]] = []
    for dataset, data in all_data.items():
        lat_jitter = dataset_jitter[dataset]
        cost_jitter = dataset_cost_jitter[dataset]
        y_jitter = dataset_y_jitter[dataset]
        for detector, d in data.items():
            lat = d["avg_latency_ms"]
            cost = d["avg_cost_usd"]
            if lat is None or cost is None:
                continue
            max_cost = max(max_cost, cost)
            lat_x = max(lat * lat_jitter, 0.01)
            cost_x = cost * 1000.0 + cost_jitter
            cluster = lat < 2.0 or cost * 1000.0 < 0.1
            y = d["op_tpr"] + (y_jitter if cluster else 0.0)
            lat_items.append((math.log10(lat_x), y, detector, dataset))
            cost_items.append((cost_x, y, detector, dataset))
    spread_lat = spread_points(
        [(x, y) for x, y, _, _ in lat_items],
        min_dx=0.12, min_dy=0.05, max_r=0.60,
    )
    spread_cost = spread_points(
        [(x, y) for x, y, _, _ in cost_items],
        min_dx=0.10, min_dy=0.05, max_r=0.60,
    )
    for (_, _, detector, dataset), (sx, sy) in zip(lat_items, spread_lat):
        if detector in ("regex_guard", "llm_judge"):
            face, edge, lw = "white", DETECTOR_COLORS[detector], 1.4
        else:
            face, edge, lw = DETECTOR_COLORS[detector], "white", 0.7
        ax_lat.scatter(
            10.0 ** sx, sy, s=65,
            facecolors=face, edgecolors=edge, linewidths=lw,
            marker=DATASET_MARKERS[dataset],
            zorder=3,
        )
    for (_, _, detector, dataset), (sx, sy) in zip(cost_items, spread_cost):
        if detector in ("regex_guard", "llm_judge"):
            face, edge, lw = "white", DETECTOR_COLORS[detector], 1.4
        else:
            face, edge, lw = DETECTOR_COLORS[detector], "white", 0.7
        ax_cost.scatter(
            sx, sy, s=65,
            facecolors=face, edgecolors=edge, linewidths=lw,
            marker=DATASET_MARKERS[dataset],
            zorder=3,
        )
    ax_lat.set_title(
        "(a) Latency Pareto", fontsize=12.5, fontweight="bold", pad=6
    )
    ax_cost.set_title(
        "(b) Cost Pareto", fontsize=12.5, fontweight="bold", pad=6
    )
    _style_axes(
        ax_lat, "Avg Latency (ms)", "TPR at default",
        (0.1, 3.0e4), (-0.06, 1.10), logx=True, grid_alpha=0.15,
        ylabel_pad=18,
    )
    ax_lat.xaxis.set_major_locator(LogLocator(base=10, numticks=6))
    ax_lat.xaxis.set_minor_locator(NullLocator())
    _style_axes(
        ax_cost, "Avg Cost ($\\times 10^{-3}$ USD)", "TPR at default",
        (0.0, max_cost * 1000.0 * 1.1), (-0.06, 1.10), grid_alpha=0.15,
        ylabel_pad=18,
    )
    handles_methods = [
        Line2D(
            [0], [0], color=DETECTOR_COLORS[d],
            linewidth=2.2 if d == "caitlyn" else 1.5,
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
            markersize=10, linestyle="None", label=dataset_labels[ds],
        )
        for ds in all_data
    ]
    fig.legend(
        handles=handles_methods,
        loc="lower center", ncol=1, frameon=False,
        fontsize=11.5, bbox_to_anchor=(0.40, -0.18),
        handlelength=2.6, handletextpad=0.7,
        borderaxespad=0.2, labelspacing=0.4,
    )
    fig.legend(
        handles=handles_datasets,
        loc="lower center", ncol=1, frameon=False,
        fontsize=11.5, bbox_to_anchor=(0.65, -0.18),
        handlelength=2.2, handletextpad=0.7,
        borderaxespad=0.2, labelspacing=0.4,
    )
    fig.subplots_adjust(
        wspace=0.55, left=0.13, right=0.985, top=0.90, bottom=0.42,
    )
    fig.savefig(out_path, bbox_inches="tight", pad_inches=0.02)
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
    plot_pareto_grid(all_data, pareto_pdf)
    plot_pareto_grid(all_data, pareto_png)
    print(f"saved {pareto_pdf} / {pareto_png}")

    roc_pr_pdf = outdir / "detection_roc_pr.pdf"
    roc_pr_png = outdir / "detection_roc_pr.png"
    plot_roc_pr_grid(all_data, roc_pr_pdf)
    plot_roc_pr_grid(all_data, roc_pr_png)
    print(f"saved {roc_pr_pdf} / {roc_pr_png}")


if __name__ == "__main__":
    main()
