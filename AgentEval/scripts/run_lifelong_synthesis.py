#!/usr/bin/env python3
"""
======================================================================
RUN-LIFELONG-SYNTHESIS

Detection-only lifelong driver for paper section 5.2.

Three methods share t=0 = shipped static library + empty DAG:
  static     — never vaccinate
  sequential — one System II loop per family wave
  batch      — one loop on the union of all seed misses

Static scanner verdicts are cached once. Later waves only add DAG
signatures. Isolated library / evolution / history / stats dirs.

Usage:
    uv run python scripts/run_lifelong_synthesis.py --method sequential --max-waves 1 --tier0-only
    uv run python scripts/run_lifelong_synthesis.py --method sequential
    uv run python scripts/run_lifelong_synthesis.py --method batch
    uv run python scripts/run_lifelong_synthesis.py --method static
    uv run python scripts/run_lifelong_synthesis.py --pruned-replay --out-dir results/lifelong_paper_20260822

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 22 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_EVAL = REPO_ROOT / "AgentEval"
CAITLYN_AGENT = REPO_ROOT / "caitlyn-agent"
sys.path.insert(0, str(AGENT_EVAL / "src"))

from agent_eval.security.lifelong_dag import (
    count_active_skills,
    load_active_dag_nodes,
    load_dag_document,
    match_active_dag_signature,
)
from agent_eval.security.lifelong_families import (
    WAVE_ORDER,
    group_emerging_rows,
    split_seed_heldout,
)
from agent_eval.security.lifelong_prune import prune_nodes
DEFAULT_EMERGING = REPO_ROOT / "valsets" / "emerging_challenge" / "emerging200.jsonl"
DEFAULT_BENIGN = (
    REPO_ROOT / "valsets" / "eval_subsets" / "agentdefense_benign_subset.jsonl"
)
# Paper and 5.1 use the 24-skill library in ~/caitlyn, not this branch's 20.
DEFAULT_LIBRARY_ROOT = Path("/home/zi/caitlyn")
NPX_TSX = ["npx", "--yes", "tsx"]
VERIFIER_BENIGN_COUNT = 5


def parse_args() -> argparse.Namespace:
    """Parse lifelong driver flags."""
    parser = argparse.ArgumentParser(description="Lifelong synthesis detection driver")
    parser.add_argument(
        "--method",
        choices=["static", "sequential", "batch"],
        required=False,
        default=None,
    )
    parser.add_argument(
        "--out-dir",
        default=str(AGENT_EVAL / "results" / "lifelong_20260822"),
    )
    parser.add_argument("--emerging", default=str(DEFAULT_EMERGING))
    parser.add_argument("--benign", default=str(DEFAULT_BENIGN))
    parser.add_argument(
        "--library-root",
        default=str(DEFAULT_LIBRARY_ROOT),
        help="Shipped antibody/antigen tree. Default: /home/zi/caitlyn (24 skills).",
    )
    parser.add_argument("--max-waves", type=int, default=0, help="0 = all nine")
    parser.add_argument("--limit-benign", type=int, default=0, help="0 = all 250")
    parser.add_argument("--tier0-only", action="store_true")
    parser.add_argument(
        "--skip-vaccinate",
        action="store_true",
        help="Evaluate with the current DAG only (no System II call)",
    )
    parser.add_argument(
        "--pruned-replay",
        action="store_true",
        help="Replay Sequential waves on a 5.1-pruned copy of the DAG. No vaccinate.",
    )
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load JSONL without splitting on Unicode line separators."""
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.strip():
            rows.append(json.loads(line))
    return rows


def write_json(path: Path, payload: Any) -> None:
    """Write pretty JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    """Write JSONL rows."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def extract_benign_text(row: dict[str, Any]) -> str:
    """Benign payload used by the detection sweep."""
    if row.get("prompt"):
        return str(row["prompt"])
    return json.dumps(row, ensure_ascii=False)


def prepare_isolated_library(out_dir: Path, library_root: Path) -> Path:
    """Copy the paper library (default ~/caitlyn) into the experiment workspace."""
    library_dir = out_dir / "library"
    source = str(library_root.resolve())
    marker = library_dir / ".source"
    if marker.is_file() and marker.read_text(encoding="utf-8").strip() == source:
        return library_dir
    if library_dir.exists():
        shutil.rmtree(library_dir)
    cache_dir = out_dir / "cache"
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    ignore = shutil.ignore_patterns(".trash", "*.tmp")
    shutil.copytree(library_root / "antibodies", library_dir / "antibodies", ignore=ignore)
    shutil.copytree(library_root / "antigens", library_dir / "antigens", ignore=ignore)
    marker.write_text(source + "\n", encoding="utf-8")
    n_abs = sum(
        1
        for path in (library_dir / "antibodies").iterdir()
        if path.is_dir() and not path.name.startswith(".")
    )
    print(f"copied library from {source} ({n_abs} antibody dirs)", flush=True)
    return library_dir


def experiment_env(out_dir: Path, library_dir: Path, evolution_dir: Path) -> dict[str, str]:
    """Env for TS helpers so they never touch ~/.caitlyn evolution or history."""
    env = os.environ.copy()
    env["CAITLYN_LIBRARY_DIR"] = str(library_dir)
    env["CAITLYN_EVOLUTION_DIR"] = str(evolution_dir)
    env["CAITLYN_HISTORY_DIR"] = str(out_dir / "history")
    env["CAITLYN_STATS_DIR"] = str(out_dir / "stats")
    return env


def cache_static_verdicts(
    out_dir: Path,
    library_dir: Path,
    items: list[dict[str, str]],
    tier0_only: bool,
) -> dict[str, dict[str, Any]]:
    """Scan each item once through the shipped library and cache verdicts."""
    cache_path = out_dir / "cache" / ("static_tier0.jsonl" if tier0_only else "static_full.jsonl")
    cached: dict[str, dict[str, Any]] = {}
    if cache_path.is_file():
        cached = {row["id"]: row for row in read_jsonl(cache_path)}
    missing = [item for item in items if item["id"] not in cached]
    if not missing:
        return {item["id"]: cached[item["id"]] for item in items}

    items_path = out_dir / "cache" / "scan_items.jsonl"
    write_jsonl(items_path, missing)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    new_path = out_dir / "cache" / "scan_chunk.jsonl"
    cmd = [
        *NPX_TSX,
        str(CAITLYN_AGENT / "scripts" / "scan-batch.ts"),
        "--input",
        str(items_path),
        "--output",
        str(new_path),
    ]
    if tier0_only:
        cmd.append("--tier0-only")
    subprocess.run(
        cmd,
        cwd=CAITLYN_AGENT,
        env=experiment_env(out_dir, library_dir, out_dir / "unused_evolution"),
        check=True,
    )
    for row in read_jsonl(new_path):
        cached[row["id"]] = row
    write_jsonl(cache_path, list(cached.values()))
    return {item["id"]: cached[item["id"]] for item in items}


def combined_blocked(
    item_id: str,
    content: str,
    static_cache: dict[str, dict[str, Any]],
    evolution_dir: Path,
) -> dict[str, Any]:
    """Static cache OR current DAG signature."""
    static_row = static_cache[item_id]
    # KEYPOINT-REVIEW: suspicious is not a block. Matches 5.1 e2e CaitlynDefense.
    static_hit = static_row.get("verdict") == "malicious"
    dag_hit = match_active_dag_signature(content, load_active_dag_nodes(evolution_dir))
    return {
        "id": item_id,
        "blocked": static_hit or dag_hit is not None,
        "static_blocked": static_hit,
        "dag_node": None if dag_hit is None else dag_hit["node_id"],
    }


def tpr_on_rows(
    rows: list[dict[str, Any]],
    static_cache: dict[str, dict[str, Any]],
    evolution_dir: Path,
) -> dict[str, Any]:
    """Held-out or seed TPR for a row list."""
    details = [
        combined_blocked(row["id"], row["injected_content"], static_cache, evolution_dir)
        for row in rows
    ]
    n = len(details)
    hits = sum(int(item["blocked"]) for item in details)
    return {"n": n, "hits": hits, "tpr": (hits / n) if n else 0.0, "details": details}


def fpr_on_benign(
    benign_items: list[dict[str, str]],
    static_cache: dict[str, dict[str, Any]],
    evolution_dir: Path,
) -> dict[str, Any]:
    """False positive rate on the fixed benign pool."""
    details = [
        combined_blocked(item["id"], item["content"], static_cache, evolution_dir)
        for item in benign_items
    ]
    n = len(details)
    hits = sum(int(item["blocked"]) for item in details)
    return {"n": n, "hits": hits, "fpr": (hits / n) if n else 0.0}


def vaccinate_cluster(
    out_dir: Path,
    library_dir: Path,
    evolution_dir: Path,
    cluster_id: str,
    misses: list[str],
    verifier_benign: list[str],
    outcome_path: Path,
) -> dict[str, Any]:
    """Run one System II loop on the antigen cluster."""
    if outcome_path.is_file():
        return json.loads(outcome_path.read_text(encoding="utf-8"))
    miss_path = outcome_path.parent / "must_detect.json"
    benign_path = outcome_path.parent / "verifier_benign.json"
    write_json(miss_path, misses)
    write_json(benign_path, verifier_benign)
    cmd = [
        *NPX_TSX,
        str(CAITLYN_AGENT / "scripts" / "vaccinate-cluster.ts"),
        "--must-detect",
        str(miss_path),
        "--benign",
        str(benign_path),
        "--cluster-id",
        cluster_id,
        "--evolution-dir",
        str(evolution_dir),
        "--out",
        str(outcome_path),
    ]
    subprocess.run(
        cmd,
        cwd=CAITLYN_AGENT,
        env=experiment_env(out_dir, library_dir, evolution_dir),
        check=True,
    )
    return json.loads(outcome_path.read_text(encoding="utf-8"))


def seed_miss_contents(
    seed_rows: list[dict[str, Any]],
    static_cache: dict[str, dict[str, Any]],
    evolution_dir: Path,
) -> list[str]:
    """Seed payloads the current static∪DAG library still misses."""
    misses: list[str] = []
    for row in seed_rows:
        verdict = combined_blocked(
            row["id"], row["injected_content"], static_cache, evolution_dir
        )
        if not verdict["blocked"]:
            misses.append(row["injected_content"])
    return misses


def summarize_wave(
    family: str,
    wave_index: int,
    current_heldout: dict[str, Any],
    previous_heldout: dict[str, Any] | None,
    fpr: dict[str, Any],
    outcome: dict[str, Any] | None,
    evolution_dir: Path,
) -> dict[str, Any]:
    """One JSONL metric row for the Sequential figure."""
    return {
        "wave": wave_index,
        "family": family,
        "current_heldout_tpr": current_heldout["tpr"],
        "current_heldout_n": current_heldout["n"],
        "previous_heldout_tpr": None if previous_heldout is None else previous_heldout["tpr"],
        "previous_heldout_n": 0 if previous_heldout is None else previous_heldout["n"],
        "fpr": fpr["fpr"],
        "fpr_n": fpr["n"],
        "active_skills": count_active_skills(evolution_dir),
        "termination": None if outcome is None else outcome.get("termination"),
        "tokens_used": 0 if outcome is None else outcome.get("tokensUsed", 0),
        "approved": [] if outcome is None else outcome.get("approved", []),
    }


def run_sequential(
    families: dict[str, list[dict[str, Any]]],
    static_cache: dict[str, dict[str, Any]],
    benign_items: list[dict[str, str]],
    verifier_benign: list[str],
    out_dir: Path,
    library_dir: Path,
    max_waves: int,
    skip_vaccinate: bool,
) -> None:
    """Nine-wave sequential synthesis with a persistent DAG."""
    evolution_dir = out_dir / "sequential" / "evolution"
    evolution_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = out_dir / "sequential" / "metrics.jsonl"
    metrics_path.write_text("", encoding="utf-8")
    previous_rows: list[dict[str, Any]] = []
    wave_names = WAVE_ORDER[:max_waves] if max_waves else WAVE_ORDER

    for index, family in enumerate(wave_names, start=1):
        seed_rows, heldout_rows = split_seed_heldout(families[family])
        wave_dir = out_dir / "sequential" / "waves" / f"{index:02d}_{family}"
        wave_dir.mkdir(parents=True, exist_ok=True)
        outcome: dict[str, Any] | None = None
        if not skip_vaccinate:
            misses = seed_miss_contents(seed_rows, static_cache, evolution_dir)
            write_json(wave_dir / "seed_miss_count.json", {"n": len(misses)})
            outcome = vaccinate_cluster(
                out_dir,
                library_dir,
                evolution_dir,
                cluster_id=f"lifelong:{family}",
                misses=misses,
                verifier_benign=verifier_benign,
                outcome_path=wave_dir / "outcome.json",
            )
        current = tpr_on_rows(heldout_rows, static_cache, evolution_dir)
        previous = (
            None
            if not previous_rows
            else tpr_on_rows(previous_rows, static_cache, evolution_dir)
        )
        fpr = fpr_on_benign(benign_items, static_cache, evolution_dir)
        row = summarize_wave(family, index, current, previous, fpr, outcome, evolution_dir)
        write_json(wave_dir / "eval.json", row)
        with metrics_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        previous_rows.extend(heldout_rows)
        print(
            f"wave {index} {family}: heldout TPR {row['current_heldout_tpr']:.3f} "
            f"prev {row['previous_heldout_tpr']} FPR {row['fpr']:.3f} "
            f"skills {row['active_skills']} term {row['termination']}",
            flush=True,
        )


def run_batch(
    families: dict[str, list[dict[str, Any]]],
    static_cache: dict[str, dict[str, Any]],
    benign_items: list[dict[str, str]],
    verifier_benign: list[str],
    out_dir: Path,
    library_dir: Path,
    skip_vaccinate: bool,
) -> None:
    """One synthesis loop on the union of all seed misses."""
    evolution_dir = out_dir / "batch" / "evolution"
    evolution_dir.mkdir(parents=True, exist_ok=True)
    all_seed: list[dict[str, Any]] = []
    all_heldout: list[dict[str, Any]] = []
    for family in WAVE_ORDER:
        seed_rows, heldout_rows = split_seed_heldout(families[family])
        all_seed.extend(seed_rows)
        all_heldout.extend(heldout_rows)
    outcome: dict[str, Any] | None = None
    if not skip_vaccinate:
        misses = seed_miss_contents(all_seed, static_cache, evolution_dir)
        outcome = vaccinate_cluster(
            out_dir,
            library_dir,
            evolution_dir,
            cluster_id="lifelong:batch",
            misses=misses,
            verifier_benign=verifier_benign,
            outcome_path=out_dir / "batch" / "outcome.json",
        )
    overall = tpr_on_rows(all_heldout, static_cache, evolution_dir)
    fpr = fpr_on_benign(benign_items, static_cache, evolution_dir)
    payload = {
        "method": "batch",
        "overall_heldout_tpr": overall["tpr"],
        "overall_heldout_n": overall["n"],
        "fpr": fpr["fpr"],
        "active_skills": count_active_skills(evolution_dir),
        "outcome": outcome,
    }
    write_json(out_dir / "batch" / "eval.json", payload)
    print(json.dumps({k: payload[k] for k in payload if k != "outcome"}, indent=2))


def run_static(
    families: dict[str, list[dict[str, Any]]],
    static_cache: dict[str, dict[str, Any]],
    benign_items: list[dict[str, str]],
    out_dir: Path,
) -> None:
    """No synthesis. Empty evolution dir."""
    evolution_dir = out_dir / "static" / "evolution"
    evolution_dir.mkdir(parents=True, exist_ok=True)
    all_heldout: list[dict[str, Any]] = []
    per_family = []
    for family in WAVE_ORDER:
        _, heldout_rows = split_seed_heldout(families[family])
        stats = tpr_on_rows(heldout_rows, static_cache, evolution_dir)
        per_family.append({"family": family, "heldout_tpr": stats["tpr"], "n": stats["n"]})
        all_heldout.extend(heldout_rows)
    overall = tpr_on_rows(all_heldout, static_cache, evolution_dir)
    fpr = fpr_on_benign(benign_items, static_cache, evolution_dir)
    payload = {
        "method": "static",
        "overall_heldout_tpr": overall["tpr"],
        "overall_heldout_n": overall["n"],
        "fpr": fpr["fpr"],
        "per_family": per_family,
        "active_skills": 0,
    }
    write_json(out_dir / "static" / "eval.json", payload)
    print(json.dumps(payload, indent=2))


def approved_ids_in_order(metrics: list[dict[str, Any]], upto_wave: int) -> list[str]:
    """Node ids accepted on waves 1..upto_wave, first-seen order."""
    seen: set[str] = set()
    ordered: list[str] = []
    for row in metrics:
        if int(row.get("wave", 0)) > upto_wave:
            continue
        for item in row.get("approved") or []:
            node_id = str(item["id"] if isinstance(item, dict) else item)
            if node_id in seen:
                continue
            seen.add(node_id)
            ordered.append(node_id)
    return ordered


def run_pruned_replay(
    families: dict[str, list[dict[str, Any]]],
    static_cache: dict[str, dict[str, Any]],
    benign_items: list[dict[str, str]],
    out_dir: Path,
    max_waves: int,
) -> None:
    """Replay Sequential eval after the 5.1 prune. Does not call System II."""
    source_dir = out_dir / "sequential" / "evolution"
    source_path = source_dir / "nodes.json"
    if not source_path.is_file():
        raise SystemExit(f"missing unpruned DAG at {source_path}")
    metrics_path = out_dir / "sequential" / "metrics.jsonl"
    if not metrics_path.is_file():
        raise SystemExit(f"missing {metrics_path}")

    backup = source_dir / "nodes.json.backup-before-prune"
    if not backup.is_file():
        shutil.copy2(source_path, backup)

    source_nodes = {
        str(node.get("id", "")): node
        for node in load_dag_document(source_dir).get("nodes", [])
        if isinstance(node, dict) and node.get("id")
    }
    metrics = read_jsonl(metrics_path)
    benign_texts = [item["content"] for item in benign_items]
    pruned_root = out_dir / "sequential_pruned"
    replay_metrics_path = pruned_root / "metrics.jsonl"
    replay_metrics_path.parent.mkdir(parents=True, exist_ok=True)
    replay_metrics_path.write_text("", encoding="utf-8")

    previous_rows: list[dict[str, Any]] = []
    all_heldout: list[dict[str, Any]] = []
    wave_names = WAVE_ORDER[:max_waves] if max_waves else WAVE_ORDER
    last_pruned: list[dict[str, Any]] = []
    last_dropped: list[dict[str, str]] = []

    for index, family in enumerate(wave_names, start=1):
        _, heldout_rows = split_seed_heldout(families[family])
        metric_row = next((row for row in metrics if int(row.get("wave", 0)) == index), None)
        snapshot_ids = approved_ids_in_order(metrics, index)
        snapshot = [source_nodes[node_id] for node_id in snapshot_ids if node_id in source_nodes]
        pruned, dropped = prune_nodes(snapshot, benign_texts)
        last_pruned, last_dropped = pruned, dropped
        wave_dir = pruned_root / "waves" / f"{index:02d}_{family}"
        wave_dir.mkdir(parents=True, exist_ok=True)
        write_json(wave_dir / "nodes.json", {"nodes": pruned})
        write_json(wave_dir / "prune_report.json", dropped)
        current = tpr_on_rows(heldout_rows, static_cache, wave_dir)
        previous = (
            None
            if not previous_rows
            else tpr_on_rows(previous_rows, static_cache, wave_dir)
        )
        fpr = fpr_on_benign(benign_items, static_cache, wave_dir)
        outcome = None
        if metric_row is not None:
            outcome = {
                "termination": metric_row.get("termination"),
                "tokensUsed": metric_row.get("tokens_used", 0),
                "approved": metric_row.get("approved") or [],
            }
        row = summarize_wave(family, index, current, previous, fpr, outcome, wave_dir)
        row["pruned_dropped"] = dropped
        write_json(wave_dir / "eval.json", row)
        with replay_metrics_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        previous_rows.extend(heldout_rows)
        all_heldout.extend(heldout_rows)
        print(
            f"pruned wave {index} {family}: heldout TPR {row['current_heldout_tpr']:.3f} "
            f"prev {row['previous_heldout_tpr']} FPR {row['fpr']:.3f} "
            f"skills {row['active_skills']} dropped {len(dropped)}",
            flush=True,
        )

    evolution_dir = pruned_root / "evolution"
    evolution_dir.mkdir(parents=True, exist_ok=True)
    write_json(evolution_dir / "nodes.json", {"nodes": last_pruned})
    write_json(pruned_root / "prune_report.json", last_dropped)
    overall = tpr_on_rows(all_heldout, static_cache, evolution_dir)
    fpr = fpr_on_benign(benign_items, static_cache, evolution_dir)
    payload = {
        "method": "sequential_pruned",
        "overall_heldout_tpr": overall["tpr"],
        "overall_heldout_n": overall["n"],
        "fpr": fpr["fpr"],
        "active_skills": count_active_skills(evolution_dir),
        "dropped": last_dropped,
    }
    write_json(pruned_root / "eval.json", payload)
    print(json.dumps({k: payload[k] for k in payload if k != "dropped"}, indent=2))


def main() -> None:
    """Prepare workspace, cache static scans, run the requested method."""
    args = parse_args()
    if not args.pruned_replay and args.method is None:
        raise SystemExit("--method is required unless --pruned-replay")
    if args.pruned_replay and args.method not in (None, "sequential"):
        raise SystemExit("--pruned-replay only replays the sequential DAG")
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    library_dir = prepare_isolated_library(out_dir, Path(args.library_root))

    emerging_rows = read_jsonl(Path(args.emerging))
    families = group_emerging_rows(emerging_rows)
    family_manifest = {
        name: {
            "n": len(rows),
            "seed": sum(int(r.get("split") == "seed") for r in rows),
            "heldout": sum(int(r.get("split") == "heldout") for r in rows),
            "ids": [r["id"] for r in rows],
        }
        for name, rows in families.items()
    }
    write_json(out_dir / "families.json", family_manifest)

    benign_rows = read_jsonl(Path(args.benign))
    if args.limit_benign:
        benign_rows = benign_rows[: args.limit_benign]
    benign_items = [
        {"id": f"benign:{row.get('id', i)}", "content": extract_benign_text(row)}
        for i, row in enumerate(benign_rows)
    ]
    verifier_benign = [item["content"] for item in benign_items[:VERIFIER_BENIGN_COUNT]]
    if len(verifier_benign) < VERIFIER_BENIGN_COUNT:
        raise SystemExit("benign pool is smaller than the verifier set")

    if args.method == "sequential" and args.max_waves:
        needed_rows = [
            row for name in WAVE_ORDER[: args.max_waves] for row in families[name]
        ]
    else:
        needed_rows = emerging_rows
    scan_items = [
        {"id": row["id"], "content": row["injected_content"]} for row in needed_rows
    ] + benign_items
    print(f"caching static scans for {len(scan_items)} strings", flush=True)
    static_cache = cache_static_verdicts(
        out_dir, library_dir, scan_items, args.tier0_only
    )

    if args.pruned_replay:
        run_pruned_replay(
            families,
            static_cache,
            benign_items,
            out_dir,
            args.max_waves,
        )
        return
    if args.method == "sequential":
        run_sequential(
            families,
            static_cache,
            benign_items,
            verifier_benign,
            out_dir,
            library_dir,
            args.max_waves,
            args.skip_vaccinate,
        )
    elif args.method == "batch":
        run_batch(
            families,
            static_cache,
            benign_items,
            verifier_benign,
            out_dir,
            library_dir,
            args.skip_vaccinate,
        )
    else:
        run_static(families, static_cache, benign_items, out_dir)


if __name__ == "__main__":
    main()
