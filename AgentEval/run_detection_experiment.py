#!/usr/bin/env python3
"""
======================================================================
RUN-DETECTION-EXPERIMENT

Run the detection-only sweep for the CAITLYN paper (main Table 2 plus
the ROC/PR figures) and save every individual detection as a JSONL
record so the curves and the cost-performance Pareto can be reproduced
without re-running agents.

Scope agreed with 团长 (2026-08-10):
  - datasets: AgentDojo-S250, ASPI-S, SafeClawBench-S240,
    AgentDefense-S1908 (Natural20 is excluded from the figures)
  - detectors: regex_guard, llm_judge, llm_judge_fewshot,
    pi_detector, caitlyn
  - every detection record stores input content, method, parameters,
    verdict, score, latency, token usage and cost.

Usage:
    python run_detection_experiment.py \
        --datasets agentdojo aspi safeclawbench agentdefense \
        --detectors regex_guard llm_judge caitlyn \
        --limit-attacks 2 --limit-benign 2 \
        --model deepseek/deepseek-v4-flash-0731 \
        --output-dir results/detection_minimal

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from agent_eval.api_keys import get_openrouter_api_key  # noqa: E402
from agent_eval.security.caitlyn_client import CaitlynClient  # noqa: E402
from agent_eval.security.dataset_adapters import (  # noqa: E402
    load_agentdojo_subset,
    load_aspi_subset,
    load_safeclawbench_subset,
)
from agent_eval.security.defenses import create_defense  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EVAL_SUBSETS = PROJECT_ROOT / "valsets" / "eval_subsets"

DATASET_CHOICES = ["agentdojo", "aspi", "safeclawbench", "agentdefense"]
DETECTOR_CHOICES = [
    "regex_guard",
    "llm_judge",
    "llm_judge_fewshot",
    "pi_detector",
    "caitlyn",
]


@dataclass
class DetectionSample:
    """One content unit to scan in the detection-only experiment."""

    dataset: str
    sample_id: str
    label: str  # "attack" | "benign"
    content: str
    source_type: str
    metadata: dict[str, Any] = field(default_factory=dict)
    shared_for: list[str] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    p = argparse.ArgumentParser(description="CAITLYN detection-only sweep")
    p.add_argument(
        "--datasets", nargs="+", choices=DATASET_CHOICES, default=DATASET_CHOICES,
        help="Datasets to scan (default: all four paper datasets)",
    )
    p.add_argument(
        "--detectors", nargs="+", choices=DETECTOR_CHOICES, default=DETECTOR_CHOICES,
        help="Detectors to evaluate (default: all five)",
    )
    p.add_argument("--limit-attacks", type=int, default=0, help="0 = all attacks")
    p.add_argument("--limit-benign", type=int, default=0, help="0 = all shared benign")
    p.add_argument(
        "--model", default="deepseek/deepseek-v4-flash-0731",
        help="LLM model id for llm_judge / llm_judge_fewshot",
    )
    p.add_argument("--base-url", default="https://openrouter.ai/api/v1")
    p.add_argument("--caitlyn-port", type=int, default=9070)
    p.add_argument("--caitlyn-mode", choices=["fast", "full"], default="full")
    p.add_argument("--caitlyn-daemon-model", default="deepseek/deepseek-chat")
    p.add_argument("--agentdefense-size", type=int, default=250)
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--output-dir", default="results/detection_experiment")
    return p.parse_args()


def _read_jsonl(path: Path, limit: int = 0) -> list[dict]:
    """Read JSONL strictly on newline boundaries."""
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").split("\n")
        if line.strip()
    ]
    return rows[:limit] if limit else rows


def _agentdefense_content(row: dict) -> str:
    """Extract the scan payload from an AgentDefense-Bench record."""
    if row.get("prompt"):
        return str(row["prompt"])
    for key in ("mcp_request", "request", "payload"):
        if row.get(key):
            return json.dumps(row[key], ensure_ascii=False)
    return ""


def _proportional_allocation(counts: dict[str, int], target: int) -> dict[str, int]:
    """Hamilton largest-remainder allocation, min 1 per non-empty stratum."""
    total = sum(counts.values())
    if total <= 0 or target <= 0:
        return {}
    base = {k: max(1, int(v * target / total)) for k, v in counts.items() if v > 0}
    used = sum(base.values())
    remainders = sorted(
        ((v * target / total - base[k], k) for k, v in counts.items() if v > 0),
        reverse=True,
    )
    for _, k in remainders:
        if used >= target:
            break
        base[k] += 1
        used += 1
    return base


def _exact_allocation(counts: dict[str, int], target: int) -> dict[str, int]:
    """Hamilton allocation trimmed down to exactly `target` items.

    ADB has many tiny strata, so the min-1 rule can overshoot the target.
    We decrement the currently largest allocations until the total is exact.
    """
    alloc = _proportional_allocation(counts, target)
    while sum(alloc.values()) > target:
        key = max(alloc, key=lambda k: (alloc[k], counts[k], k))
        alloc[key] -= 1
        if alloc[key] <= 0:
            del alloc[key]
    return alloc


def _stratified_sample(
    items: list[dict], strata_key: str, target: int, seed: int
) -> list[dict]:
    """Deterministic proportional stratified sample keyed by strata_key."""
    rng = random.Random(seed)
    groups: dict[str, list[dict]] = {}
    for item in items:
        groups.setdefault(str(item.get(strata_key, "unknown")), []).append(item)
    allocation = _exact_allocation(
        {k: len(v) for k, v in groups.items()}, target
    )
    sampled: list[dict] = []
    for stratum, take in allocation.items():
        pool = groups[stratum]
        sampled.extend(rng.sample(pool, min(take, len(pool))))
    rng.shuffle(sampled)
    return sampled


def ensure_agentdefense_subset(size: int) -> Path:
    """Return (and lazily create) the stratified AgentDefense-S{size} subset."""
    out_path = EVAL_SUBSETS / f"agentdefense_detection_subset_s{size}.jsonl"
    if out_path.exists():
        return out_path
    full = _read_jsonl(EVAL_SUBSETS / "agentdefense_detection_subset.jsonl")
    subset = _stratified_sample(full, "source", size, 20260810)
    out_path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False) + "\n" for row in subset
        ),
        encoding="utf-8",
    )
    return out_path


def load_attack_samples(
    dataset: str, limit: int, agentdefense_size: int = 250
) -> list[DetectionSample]:
    """Load attack samples for one dataset with content extraction."""
    samples: list[DetectionSample] = []

    if dataset == "agentdojo":
        cases = load_agentdojo_subset(
            attacks_path=EVAL_SUBSETS / "agentdojo_subset.jsonl",
            injections_path=EVAL_SUBSETS / "agentdojo_subset_injections.jsonl",
            benign_path=EVAL_SUBSETS / "agentdojo_benign_tasks.jsonl",
            max_attacks=limit if limit else 250,
            max_benign=0,
        )
        for tc in cases:
            if tc.label != "injection" or not tc.injected_content:
                continue
            samples.append(DetectionSample(
                dataset=dataset,
                sample_id=tc.task_id,
                label="attack",
                content=tc.injected_content,
                source_type="mcp_tool_call",
                metadata=tc.metadata,
            ))

    elif dataset == "aspi":
        cases = load_aspi_subset(EVAL_SUBSETS / "aspi_subset.jsonl", max_rows=31)
        for tc in cases:
            if tc.label != "injection" or not tc.injected_content:
                continue
            samples.append(DetectionSample(
                dataset=dataset,
                sample_id=tc.task_id,
                label="attack",
                content=tc.injected_content,
                source_type="prompt",
                metadata=tc.metadata,
            ))

    elif dataset == "safeclawbench":
        cases = load_safeclawbench_subset(
            EVAL_SUBSETS / "safeclawbench_subset.jsonl",
            max_cases=limit if limit else 240,
        )
        for tc in cases:
            samples.append(DetectionSample(
                dataset=dataset,
                sample_id=tc.task_id,
                label="attack",
                content=tc.problem_statement,
                source_type="prompt",
                metadata=tc.metadata,
            ))

    elif dataset == "agentdefense":
        rows = _read_jsonl(
            ensure_agentdefense_subset(agentdefense_size), limit
        )
        for row in rows:
            content = _agentdefense_content(row)
            if not content:
                continue
            samples.append(DetectionSample(
                dataset=dataset,
                sample_id=str(row.get("id", "")),
                label="attack",
                content=content,
                source_type=(
                    "mcp_tool_call" if row.get("mcp_request") else "prompt"
                ),
                metadata={
                    "category": row.get("category"),
                    "source": row.get("source"),
                    "source_file": row.get("source_file"),
                    "severity": row.get("severity"),
                    "attack_type": row.get("attack_type"),
                },
            ))

    return samples[:limit] if limit else samples


def load_shared_benign(limit: int) -> list[DetectionSample]:
    """Load the shared benign pool (AgentDefense-Bench benign subset)."""
    rows = _read_jsonl(EVAL_SUBSETS / "agentdefense_benign_subset.jsonl", limit)
    samples: list[DetectionSample] = []
    for row in rows:
        content = row.get("prompt") or json.dumps(row, ensure_ascii=False)
        samples.append(DetectionSample(
            dataset="shared_benign",
            sample_id=str(row.get("id", "")),
            label="benign",
            content=content,
            source_type="prompt",
            metadata={
                "category": row.get("category"),
                "source": row.get("source"),
            },
            shared_for=DATASET_CHOICES,
        ))
    return samples


def make_detector(
    name: str, api_key: str, base_url: str, model: str, caitlyn_port: int
) -> Any:
    """Create a detector instance (CaitlynClient or a Defense subclass)."""
    if name == "caitlyn":
        client = CaitlynClient(port=caitlyn_port)
        if not client.health():
            raise ConnectionError(f"CAITLYN daemon not reachable on port {caitlyn_port}")
        return client
    return create_defense(
        name,
        api_key=api_key,
        base_url=base_url,
        model=model,
        caitlyn_port=caitlyn_port,
    )


def run_one_job(
    detector_name: str,
    sample: DetectionSample,
    params: dict[str, Any],
    api_key: str,
    base_url: str,
    model: str,
    caitlyn_port: int,
) -> dict:
    """Create a fresh detector and scan one sample.

    A fresh instance per call avoids races on per-detector state such as
    Defense.last_result when the same detector runs concurrently.
    """
    detector = make_detector(
        detector_name, api_key, base_url, model, caitlyn_port
    )
    return scan_one(detector, detector_name, sample, params)


def scan_one(
    detector: Any,
    detector_name: str,
    sample: DetectionSample,
    params: dict[str, Any],
) -> dict:
    """Run one detector on one sample and return the full JSONL record."""
    record: dict[str, Any] = {
        "schema_version": "1.0",
        "run_id": params["run_id"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dataset": sample.dataset,
        "sample_id": sample.sample_id,
        "label": sample.label,
        "shared_for": sample.shared_for,
        "source_type": sample.source_type,
        "metadata": sample.metadata,
        "detector": detector_name,
        "params": params,
        "input": {
            "chars": len(sample.content),
            "content": sample.content,
        },
    }

    try:
        if detector_name == "caitlyn":
            verdict = detector.scan(
                sample.content,
                source=sample.source_type,
                mode=params["caitlyn_mode"],
            )
            record["result"] = {
                "blocked": verdict.is_suspicious,
                "verdict": verdict.verdict,
                "confidence": verdict.confidence,
                "score": verdict.confidence,
                "reasoning": verdict.reasoning,
                "matched_antibodies": verdict.matched_antibodies,
            }
            record["cost"] = {
                "latency_ms": verdict.latency_ms,
                "tokens": verdict.tokens,
                "prompt_tokens": None,
                "completion_tokens": None,
                "cached_tokens": None,
                "cost_usd": None,
            }
        else:
            start = time.time()
            _, blocked = detector.filter(sample.content, source=sample.source_type)
            wall_latency_ms = (time.time() - start) * 1000.0
            last = getattr(detector, "last_result", {})
            usage = last.get("usage", {})
            record["result"] = {
                "blocked": blocked,
                "verdict": last.get("verdict"),
                "confidence": last.get("confidence"),
                "score": last.get("score"),
                "reasoning": last.get("reasoning"),
                "matched_patterns": last.get("matched_patterns"),
                "label": last.get("label"),
                "error": last.get("error"),
            }
            record["cost"] = {
                "latency_ms": last.get("latency_ms", wall_latency_ms),
                "tokens": last.get("tokens", 0),
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "cached_tokens": usage.get("cached_tokens"),
                "cost_usd": usage.get("cost_usd"),
            }
        record["error"] = None
    except Exception as exc:  # noqa: BLE001 - record and continue
        record["result"] = {"blocked": False, "error": str(exc)}
        record["cost"] = {}
        record["error"] = str(exc)
    return record


def summarize(records: list[dict]) -> dict:
    """Aggregate TPR / FPR / cost per dataset and detector."""
    cells: dict[str, dict[str, dict[str, Any]]] = {}
    for rec in records:
        dataset = rec["dataset"]
        detector = rec["detector"]
        cell = cells.setdefault(dataset, {}).setdefault(detector, {
            "attacks": 0,
            "attacks_blocked": 0,
            "benign": 0,
            "benign_blocked": 0,
            "latency_ms": [],
            "tokens": [],
            "cost_usd": [],
        })
        if rec["label"] == "attack":
            cell["attacks"] += 1
            cell["attacks_blocked"] += int(rec["result"].get("blocked", False))
        else:
            cell["benign"] += 1
            cell["benign_blocked"] += int(rec["result"].get("blocked", False))
        cost = rec.get("cost", {})
        latency = cost.get("latency_ms")
        tokens = cost.get("tokens")
        usd = cost.get("cost_usd")
        if latency is not None:
            cell["latency_ms"].append(float(latency))
        if tokens is not None:
            cell["tokens"].append(int(tokens))
        if usd is not None:
            cell["cost_usd"].append(float(usd))

    # The shared benign pool gives every dataset column the same FPR base.
    if "shared_benign" in cells:
        for dataset in DATASET_CHOICES:
            if dataset not in cells:
                continue
            for detector, shared_cell in cells["shared_benign"].items():
                cell = cells[dataset].setdefault(detector, {
                    "attacks": 0,
                    "attacks_blocked": 0,
                    "benign": 0,
                    "benign_blocked": 0,
                    "latency_ms": [],
                    "tokens": [],
                    "cost_usd": [],
                })
                cell["benign"] = shared_cell["benign"]
                cell["benign_blocked"] = shared_cell["benign_blocked"]
                cell["latency_ms"].extend(shared_cell["latency_ms"])
                cell["tokens"].extend(shared_cell["tokens"])
                cell["cost_usd"].extend(shared_cell["cost_usd"])

    summary: dict[str, Any] = {}
    for dataset, detector_cells in cells.items():
        summary[dataset] = {}
        for detector, c in detector_cells.items():
            tpr = (
                c["attacks_blocked"] / c["attacks"]
                if c["attacks"] else None
            )
            fpr = (
                c["benign_blocked"] / c["benign"]
                if c["benign"] else None
            )
            summary[dataset][detector] = {
                "tpr": tpr,
                "fpr": fpr,
                "attacks": c["attacks"],
                "attacks_blocked": c["attacks_blocked"],
                "benign": c["benign"],
                "benign_blocked": c["benign_blocked"],
                "avg_latency_ms": (
                    sum(c["latency_ms"]) / len(c["latency_ms"])
                    if c["latency_ms"] else None
                ),
                "avg_tokens": (
                    sum(c["tokens"]) / len(c["tokens"])
                    if c["tokens"] else None
                ),
                "avg_cost_usd": (
                    sum(c["cost_usd"]) / len(c["cost_usd"])
                    if c["cost_usd"] else None
                ),
            }
    return summary


def print_summary(summary: dict[str, Any]) -> None:
    """Print a compact per-dataset/per-detector table."""
    print("\n=== DETECTION SUMMARY ===")
    for dataset, detector_cells in summary.items():
        print(f"\n[{dataset}]")
        for detector, m in detector_cells.items():
            tpr = f"{m['tpr']:.1%}" if m["tpr"] is not None else "n/a"
            fpr = f"{m['fpr']:.1%}" if m["fpr"] is not None else "n/a"
            lat = f"{m['avg_latency_ms']:.1f}" if m["avg_latency_ms"] is not None else "n/a"
            tok = f"{m['avg_tokens']:.0f}" if m["avg_tokens"] is not None else "n/a"
            print(
                f"  {detector:18s} TPR={tpr} FPR={fpr} "
                f"latency={lat}ms tokens={tok}"
            )


def main() -> None:
    """Run the sweep and write records + summary to --output-dir."""
    args = parse_args()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    records_path = out_dir / "records.jsonl"
    summary_path = out_dir / "summary.json"

    try:
        api_key = get_openrouter_api_key()
    except Exception:
        api_key = ""

    samples: list[DetectionSample] = []
    for dataset in args.datasets:
        samples.extend(
            load_attack_samples(dataset, args.limit_attacks, args.agentdefense_size)
        )
    samples.extend(load_shared_benign(args.limit_benign))

    params: dict[str, Any] = {
        "run_id": run_id,
        "model": args.model,
        "base_url": args.base_url,
        "caitlyn_port": args.caitlyn_port,
        "caitlyn_mode": args.caitlyn_mode,
        "caitlyn_daemon_model": args.caitlyn_daemon_model,
        "max_tokens": 256,
        "workers": args.workers,
        "agentdefense_size": args.agentdefense_size,
        "limit_attacks": args.limit_attacks,
        "limit_benign": args.limit_benign,
    }

    print(
        f"Running {len(samples)} samples x {len(args.detectors)} detectors "
        f"(model={args.model})"
    )
    records: list[dict] = []
    write_lock = Lock()
    done_count = 0
    total_jobs = len(args.detectors) * len(samples)
    with records_path.open("w", encoding="utf-8") as fh:
        for detector_name in args.detectors:
            # PI Detector shares a class-level HF pipeline; keep it sequential
            # to avoid concurrent inference on the same pipeline object.
            workers = 1 if detector_name == "pi_detector" else args.workers
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = [
                    executor.submit(
                        run_one_job,
                        detector_name,
                        sample,
                        params,
                        api_key,
                        args.base_url,
                        args.model,
                        args.caitlyn_port,
                    )
                    for sample in samples
                ]
                for future in as_completed(futures):
                    record = future.result()
                    with write_lock:
                        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                        fh.flush()
                        records.append(record)
                        done_count += 1
                        if done_count % 100 == 0 or done_count == total_jobs:
                            print(
                                f"  progress {done_count}/{total_jobs} "
                                f"(detector={detector_name})",
                                flush=True,
                            )

    summary = summarize(records)
    summary_path.write_text(
        json.dumps({
            "config": vars(args),
            "run_id": run_id,
            "records_path": str(records_path),
            "summary": summary,
        }, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print_summary(summary)
    print(f"\nRecords saved to {records_path}")
    print(f"Summary saved to {summary_path}")


if __name__ == "__main__":
    main()
