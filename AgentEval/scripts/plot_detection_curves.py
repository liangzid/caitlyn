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

    Author: [AUTHOR] <[EMAIL]>
    Copyright (C) 2026, [AUTHOR], all rights reserved.
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
from matplotlib.gridspec import GridSpec  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.ticker import LogLocator, MaxNLocator, NullLocator  # noqa: E402

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
# Pareto markers share DETECTOR_COLORS with ROC/PR so the paper keeps
# one detector ink set. REVIEW(团长): previously a muted earth palette.
PARETO_COLORS = {
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


ATTACK_VERDICTS = {"malicious", "suspicious"}


def detector_fired_as_attack(record: dict) -> bool:
    """Return True when the detector treated the sample as attack-like."""
    result = record.get("result") or {}
    if result.get("blocked"):
        return True
    verdict = str(result.get("verdict") or "").lower()
    return verdict in ATTACK_VERDICTS


def score_of(record: dict) -> float:
    """Return a ranking score that is comparable across detectors.

    LLM judges, PI Detector, and merged-pair CAITLYN store the
    confidence of the predicted class, not P(attack). Sweeping the raw
    value inverts the ROC because benign predictions also have high
    confidence. A firing detection keeps its confidence, and a
    non-firing detection is mapped to 0. This matches the ensemble
    CAITLYN records, where benign verdicts were stored as score 0.

    KEYPOINT (review): this mapping is the only score used for ROC/PR.
    """
    result = record.get("result") or {}
    raw = result.get("score")
    if raw is None:
        raw = result.get("confidence")
    confidence = float(raw) if raw is not None else 0.0
    if detector_fired_as_attack(record):
        return confidence
    return 0.0


def blocked_of(record: dict) -> bool:
    """Extract the operating-point verdict."""
    return bool((record.get("result") or {}).get("blocked", False))


def roc_points(
    scores: list[float], labels: list[int]
) -> tuple[list[float], list[float], float]:
    """Return FPR/TPR points and AUROC by sweeping all score thresholds."""
    total_p = sum(labels)
    total_n = len(labels) - total_p
    thresholds = [float("inf")] + sorted(set(scores), reverse=True) + [float("-inf")]
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
    thresholds = [float("inf")] + sorted(set(scores), reverse=True) + [float("-inf")]
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


def usd_cost_of(record: dict, detector: str) -> float:
    """Return the recorded USD cost, or a detector-appropriate fallback.

    Regex-Guard and PI Detector have no LLM usage, so a missing cost is
    zero rather than a DeepSeek token estimate.
    """
    raw = (record.get("cost") or {}).get("cost_usd")
    if raw is not None:
        return float(raw)
    if detector in ("regex_guard", "pi_detector"):
        return 0.0
    return estimate_caitlyn_cost(record)


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
        # The Pareto and the appendix table share one metric: mean
        # per-sample latency/cost over every sample in the dataset column
        # (attacks plus the shared benign pool). This keeps Figure 6 and
        # summary.json on the same numbers.
        pool = attacks + [
            r for r in benign if r["detector"] == detector
        ]
        latencies = [
            (r.get("cost") or {}).get("latency_ms")
            for r in pool
            if (r.get("cost") or {}).get("latency_ms") is not None
        ]
        costs = [usd_cost_of(r, detector) for r in pool]
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


def plot_threshold_curve(
    ax: Any, xs: list[float], ys: list[float], detector: str
) -> None:
    """Draw one ROC or PR curve, with a white halo for CAITLYN."""
    color = DETECTOR_COLORS[detector]
    linestyle = DETECTOR_LINESTYLES[detector]
    if detector == "caitlyn":
        ax.plot(
            xs, ys, color="white", linewidth=5.0, linestyle="-",
            solid_capstyle="round", zorder=4.5,
        )
        ax.plot(
            xs, ys, color=color, linewidth=2.6, linestyle=linestyle,
            solid_capstyle="round", zorder=5,
        )
        return
    ax.plot(
        xs, ys, color=color, linewidth=1.2, linestyle=linestyle,
        solid_capstyle="round", zorder=3, alpha=0.85,
    )


def plot_dataset_figure(
    data: dict[str, dict[str, Any]],
    dataset: str,
    out_path: Path,
) -> None:
    """Save one ROC+PR figure per dataset."""
    fig, (ax_roc, ax_pr) = plt.subplots(
        1, 2, figsize=(10.5, 4.2), dpi=200
    )
    curve_order = [det for det in DETECTORS if det in data and det != "caitlyn"]
    if "caitlyn" in data:
        curve_order.append("caitlyn")
    for detector in curve_order:
        d = data[detector]
        fprs, tprs, auroc = roc_points(d["scores"], d["labels"])
        recalls, precisions, auprc = pr_points(d["scores"], d["labels"])
        label = (
            f"{DETECTOR_LABELS[detector]} "
            f"(AUROC {auroc:.3f} / AUPRC {auprc:.3f})"
        )
        plot_threshold_curve(ax_roc, fprs, tprs, detector)
        ax_roc.plot(
            [], [], color=DETECTOR_COLORS[detector],
            linestyle=DETECTOR_LINESTYLES[detector],
            linewidth=2.6 if detector == "caitlyn" else 1.2,
            label=label,
        )
        ax_roc.plot(
            d["op_fpr"], d["op_tpr"], marker="s", markersize=5,
            color=DETECTOR_COLORS[detector], linestyle="None",
        )
        plot_threshold_curve(ax_pr, recalls, precisions, detector)
        ax_pr.plot(
            d["op_recall"], d["op_precision"], marker="s", markersize=5,
            color=DETECTOR_COLORS[detector], linestyle="None",
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
    # Low-recall precision is 1.0 for any FPR=0 detector and is not
    # informative. The paper PR panels start at recall 0.5.
    ax_pr.set_xlim(0.48, 1.02)
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
        "font.serif": ["Times New Roman", "Liberation Serif", "DejaVu Serif"],
        "mathtext.fontset": "stix",
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
            if detector == "caitlyn":
                ax_roc.plot(
                    d["op_fpr"], d["op_tpr"], marker="D", markersize=4.2,
                    color=DETECTOR_COLORS["caitlyn"],
                    markerfacecolor=DETECTOR_COLORS["caitlyn"],
                    markeredgecolor="white", markeredgewidth=0.5,
                    linestyle="None", zorder=4,
                )
                ax_pr.plot(
                    d["op_recall"], d["op_precision"], marker="D",
                    markersize=4.2, color=DETECTOR_COLORS["caitlyn"],
                    markerfacecolor=DETECTOR_COLORS["caitlyn"],
                    markeredgecolor="white", markeredgewidth=0.5,
                    linestyle="None", zorder=4,
                )
                continue
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
        "font.serif": ["Times New Roman", "Liberation Serif", "DejaVu Serif"],
        "mathtext.fontset": "stix",
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
    fig = plt.figure(figsize=(10.0, 4.18), dpi=200)
    gs = fig.add_gridspec(
        2,
        4,
        hspace=0.72,
        wspace=0.60,
        left=0.13,
        right=0.985,
        top=0.94,
        bottom=0.185,
    )
    axes = [
        [fig.add_subplot(gs[row, col]) for col in range(4)]
        for row in range(2)
    ]
    for i, dataset in enumerate(datasets):
        data = all_data[dataset]
        ax_roc = axes[0][i]
        ax_pr = axes[1][i]
        curve_order = [
            det for det in DETECTORS if det in data and det != "caitlyn"
        ]
        if "caitlyn" in data:
            curve_order.append("caitlyn")
        for detector in curve_order:
            d = data[detector]
            fprs, tprs, _ = roc_points(d["scores"], d["labels"])
            recalls, precisions, _ = pr_points(d["scores"], d["labels"])
            plot_threshold_curve(ax_roc, fprs, tprs, detector)
            plot_threshold_curve(ax_pr, recalls, precisions, detector)
        detector_order = [det for det in DETECTORS if det in data]
        roc_ops = spread_points(
            [(data[det]["op_fpr"], data[det]["op_tpr"])
             for det in detector_order],
            min_dx=0.06, min_dy=0.05, max_r=0.45,
        )
        for det, (x, y) in zip(detector_order, roc_ops):
            ax_roc.plot(
                x, y, marker=OP_MARKERS[det], markersize=5.0,
                color=DETECTOR_COLORS[det],
                markerfacecolor=DETECTOR_COLORS[det],
                markeredgecolor="white", markeredgewidth=0.7,
                linestyle="None", zorder=4,
            )
        if "caitlyn" in data:
            cait_idx = detector_order.index("caitlyn")
            cx, cy = roc_ops[cait_idx]
            ax_roc.plot(
                cx, cy, marker="D", markersize=10.0, color="white",
                linestyle="None", zorder=5.5,
            )
            ax_roc.plot(
                cx, cy, marker="D", markersize=6.0,
                color=DETECTOR_COLORS["caitlyn"],
                markerfacecolor=DETECTOR_COLORS["caitlyn"],
                markeredgecolor="white", markeredgewidth=0.8,
                linestyle="None", zorder=6,
            )
            cait = data["caitlyn"]
            ax_pr.plot(
                cait["op_recall"], cait["op_precision"],
                marker="D", markersize=10.0, color="white",
                linestyle="None", zorder=5.5,
            )
            ax_pr.plot(
                cait["op_recall"], cait["op_precision"],
                marker="D", markersize=6.0,
                color=DETECTOR_COLORS["caitlyn"],
                markerfacecolor=DETECTOR_COLORS["caitlyn"],
                markeredgecolor="white", markeredgewidth=0.8,
                linestyle="None", zorder=6,
            )
        ax_roc.plot(
            [0, 1], [0, 1], color="#bbbbbb", linewidth=1.0,
            linestyle="--", zorder=0,
        )
        ax_roc.set_title(
            f"({letters[i]}) {titles[dataset]}",
            fontsize=12.5, fontweight="bold", pad=3,
        )
        ax_pr.set_title(
            f"({letters[4 + i]}) {titles[dataset]}",
            fontsize=12.5, fontweight="bold", pad=3,
        )
        _style_axes(ax_roc, "FPR", "TPR", (-0.02, 1.02), (-0.02, 1.06))
        # KEYPOINT (review): PR x-axis starts at 0.5. The 0-0.5 band is a
        # precision=1.0 plateau whenever FPR is 0, so it does not separate
        # detectors. Operating points with recall below 0.5 fall off this
        # panel (PI Detector on three datasets, LLM-Judge on SafeClawBench).
        _style_axes(ax_pr, "Recall", "Precision", (0.48, 1.02), (-0.02, 1.06))
        ax_roc.set_xticks([0.0, 0.25, 0.5, 0.75, 1.0])
        ax_roc.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])
        ax_pr.set_xticks([0.5, 0.75, 1.0])
        ax_pr.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])
        ax_roc.xaxis.labelpad = 0.5
        ax_pr.xaxis.labelpad = 0.8
        ax_roc.tick_params(axis="x", pad=1.0)
        ax_pr.tick_params(axis="x", pad=1.0)

    handles_methods = [
        Line2D(
            [0], [0], color=DETECTOR_COLORS[d],
            linewidth=2.2 if d == "caitlyn" else 1.5,
            linestyle=DETECTOR_LINESTYLES[d],
            label=DETECTOR_LABELS[d],
        )
        for d in DETECTORS
    ]
    fig.legend(
        handles=handles_methods,
        loc="lower center",
        ncol=5,
        frameon=False,
        fontsize=13.0,
        bbox_to_anchor=(0.53, 0.014),
        columnspacing=1.6,
        handlelength=2.4,
        handletextpad=0.55,
        borderaxespad=0.0,
        handleheight=0.7,
    )
    fig.text(
        0.012, 0.73, "ROC", rotation=90, va="center", ha="center",
        fontsize=12.5, fontweight="bold",
    )
    fig.text(
        0.012, 0.42, "PR", rotation=90, va="center", ha="center",
        fontsize=12.5, fontweight="bold",
    )
    fig.savefig(out_path, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


# Scatter area in pt^2. Matplotlib `s` is marker area, but circles and
# triangles read smaller than squares and diamonds at the same s.
PARETO_MARKER_SIZE = 155
PARETO_MARKER_EDGE = 1.05
PARETO_MARKER_AREA_SCALE = {
    "o": 1.18,
    "s": 1.00,
    "^": 1.38,
    "v": 1.38,
    "D": 0.98,
}
PARETO_DATASET_TITLES = {
    "agentdojo": "AgentDojo",
    "aspi": "ASPI-S",
    "safeclawbench": "SafeClawBench",
    "agentdefense": "AgentDefense",
}


def scatter_operating_point(ax: Any, x: float, y: float, detector: str) -> None:
    """Draw one default-threshold point with shape-matched visual size."""
    marker = OP_MARKERS[detector]
    color = PARETO_COLORS[detector]
    area = PARETO_MARKER_SIZE * PARETO_MARKER_AREA_SCALE[marker]
    if detector == "caitlyn":
        ax.scatter(
            [x],
            [y],
            s=area * 2.15,
            marker=marker,
            facecolors="none",
            edgecolors=color,
            linewidths=1.35,
            zorder=5,
            clip_on=False,
        )
    ax.scatter(
        [x],
        [y],
        s=area,
        marker=marker,
        facecolors=color,
        edgecolors="white",
        linewidths=PARETO_MARKER_EDGE,
        zorder=6 if detector == "caitlyn" else 4,
        clip_on=False,
    )


def _pareto_detector_order(data: dict[str, dict[str, Any]]) -> list[str]:
    """Draw baselines first so CAITLYN sits on top when points overlap."""
    order = [det for det in DETECTORS if det in data and det != "caitlyn"]
    if "caitlyn" in data:
        order.append("caitlyn")
    return order


def _pareto_metric_row(
    fig: Any,
    spec: Any,
    *,
    metric_name: str,
    all_data: dict[str, dict[str, dict[str, Any]]],
    datasets: list[str],
    letters: str,
    xlabel: str,
    xlim: tuple[float, float],
    logx: bool,
    x_of,
    sharey: Any,
) -> Any:
    """Build one metric row: a centered row name, dataset titles, then panels.

    KEYPOINT (review): metric_name is a GridSpec band above the four
    panels, so it stays locked to that row.
    """
    gs = spec.subgridspec(
        3,
        4,
        height_ratios=[0.07, 0.10, 0.72],
        hspace=0.008,
        wspace=0.16,
    )
    ax_metric = fig.add_subplot(gs[0, :])
    ax_metric.set_axis_off()
    ax_metric.text(
        0.5,
        0.0,
        metric_name,
        ha="center",
        va="bottom",
        fontsize=13.5,
        fontweight="bold",
        transform=ax_metric.transAxes,
    )
    first_ax = None
    for i, dataset in enumerate(datasets):
        ax_title = fig.add_subplot(gs[1, i])
        ax_title.set_axis_off()
        ax_title.text(
            0.5,
            0.0,
            f"({letters[i]}) {PARETO_DATASET_TITLES[dataset]}",
            ha="center",
            va="bottom",
            fontsize=12,
            fontweight="bold",
            transform=ax_title.transAxes,
        )
        ax = fig.add_subplot(gs[2, i], sharey=sharey)
        if first_ax is None:
            first_ax = ax
            sharey = ax
        data = all_data[dataset]
        for detector in _pareto_detector_order(data):
            d = data[detector]
            x = x_of(d)
            if x is None:
                continue
            scatter_operating_point(ax, x, d["op_tpr"], detector)
        _style_pareto_panel(
            ax,
            xlabel,
            xlim,
            logx=logx,
            show_ylabel=(i == 0),
        )
    return sharey


def plot_pareto_grid(
    all_data: dict[str, dict[str, dict[str, Any]]],
    out_path: Path,
) -> None:
    """Save a 2x4 TPR vs latency/cost figure, one column per dataset.

    Each point is the mean over all samples in the dataset column (attacks
    plus the shared benign pool) at the default threshold. Marker size is
    shared across detectors.
    """
    plt.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Times New Roman", "Liberation Serif", "DejaVu Serif"],
        "mathtext.fontset": "stix",
        "font.size": 12,
        "axes.titlesize": 12,
        "axes.labelsize": 12,
        "legend.fontsize": 12,
        "xtick.labelsize": 11,
        "ytick.labelsize": 11,
        "axes.linewidth": 1.4,
        "legend.frameon": False,
    })
    datasets = [ds for ds in DATASETS if ds in all_data]
    max_cost = 0.0
    for data in all_data.values():
        for d in data.values():
            if d["avg_cost_usd"] is not None:
                max_cost = max(max_cost, d["avg_cost_usd"])
    cost_xmax = max(max_cost * 1000.0 * 1.12, 0.2)

    fig = plt.figure(figsize=(11.0, 4.20), dpi=300)
    panels = GridSpec(
        2,
        1,
        figure=fig,
        hspace=0.32,
        left=0.06,
        right=0.995,
        top=0.98,
        bottom=0.22,
    )

    def lat_x(d: dict[str, Any]) -> float | None:
        lat = d["avg_latency_ms"]
        return None if lat is None else max(float(lat), 0.2)

    def cost_x(d: dict[str, Any]) -> float | None:
        cost = d["avg_cost_usd"]
        return None if cost is None else float(cost) * 1000.0

    sharey = _pareto_metric_row(
        fig,
        panels[0],
        metric_name="Latency",
        all_data=all_data,
        datasets=datasets,
        letters="abcd",
        xlabel="Latency (ms)",
        xlim=(0.2, 2.0e4),
        logx=True,
        x_of=lat_x,
        sharey=None,
    )
    _pareto_metric_row(
        fig,
        panels[1],
        metric_name="Cost",
        all_data=all_data,
        datasets=datasets,
        letters="efgh",
        xlabel=r"Cost ($\times 10^{-3}$ USD)",
        xlim=(-0.12, cost_xmax),
        logx=False,
        x_of=cost_x,
        sharey=sharey,
    )

    handles = [
        Line2D(
            [0],
            [0],
            marker=OP_MARKERS[d],
            color="none",
            markerfacecolor=PARETO_COLORS[d],
            markeredgecolor="white",
            markeredgewidth=0.8,
            markersize=11.5 * (PARETO_MARKER_AREA_SCALE[OP_MARKERS[d]] ** 0.5),
            linestyle="None",
            label=DETECTOR_LABELS[d],
        )
        for d in DETECTORS
    ]
    fig.legend(
        handles=handles,
        loc="upper center",
        ncol=5,
        frameon=False,
        fontsize=12,
        bbox_to_anchor=(0.54, 0.07),
        columnspacing=1.6,
        handlelength=1.4,
        handletextpad=0.4,
        borderaxespad=0.0,
    )
    fig.savefig(out_path, dpi=300, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def _style_pareto_panel(
    ax: Any,
    xlabel: str,
    xlim: tuple[float, float],
    *,
    logx: bool,
    show_ylabel: bool,
) -> None:
    """Apply compact publication spines, ticks, and a shared TPR scale."""
    _style_axes(
        ax,
        xlabel,
        "TPR" if show_ylabel else "",
        xlim,
        (-0.03, 1.05),
        logx=logx,
        grid_alpha=0.22,
        ylabel_pad=3.0,
    )
    ax.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])
    ax.set_facecolor("white")
    ax.grid(color="#D0D0D0", alpha=0.75, linewidth=0.55)
    ax.spines["left"].set_color("#444444")
    ax.spines["bottom"].set_color("#444444")
    ax.spines["left"].set_linewidth(1.15)
    ax.spines["bottom"].set_linewidth(1.15)
    ax.tick_params(length=3.0, width=1.0, labelsize=11, colors="#333333", pad=1.2)
    ax.xaxis.labelpad = 1.5
    ax.xaxis.label.set_color("#333333")
    ax.yaxis.label.set_color("#333333")
    if not show_ylabel:
        ax.tick_params(labelleft=False)
    if logx:
        ax.xaxis.set_major_locator(LogLocator(base=10, numticks=4))
        ax.xaxis.set_minor_locator(NullLocator())
    else:
        ax.xaxis.set_major_locator(MaxNLocator(nbins=4, prune=None))


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
        for detector, d in data.items():
            _, _, auroc = roc_points(d["scores"], d["labels"])
            _, _, auprc = pr_points(d["scores"], d["labels"])
            print(
                f"{DETECTOR_LABELS[detector]:16s} {dataset:14s} "
                f"AUROC={auroc:.3f} AUPRC={auprc:.3f} "
                f"TPR={d['op_tpr']:.3f} FPR={d['op_fpr']:.3f}"
            )
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
