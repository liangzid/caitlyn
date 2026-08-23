#!/usr/bin/env python3
"""
======================================================================
RUN-ADAPTIVE-ATTACK

Detection-only skill-aware rewriter for paper section 5.3.

Protocol (locked):
  start from OpenClaw Caitlyn-evolved blocked Emerging cases
  one LLM rewriter, K=5, sees the four evolved skill sources
  oracle = 5.2 DAG wrapper OR static library (optional --dag-only)
  one extra vaccinate cluster on escapes
  report escape rate and benign FPR before/after that vaccinate

Usage:
    uv run python scripts/run_adaptive_attack.py --limit 3 --dag-only
    uv run python scripts/run_adaptive_attack.py --skip-vaccinate
    uv run python scripts/run_adaptive_attack.py

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 22 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_EVAL = REPO_ROOT / "AgentEval"
sys.path.insert(0, str(AGENT_EVAL / "src"))

from agent_eval.api_keys import get_openrouter_api_key
from agent_eval.security.adaptive_attack import (
    attacker_target_of,
    call_openrouter_json,
    dag_block,
    extract_evolved_blocked_rows,
    rewrite_until_miss,
)
from agent_eval.security.lifelong_dag import (
    count_active_skills,
    load_active_dag_nodes,
)

DEFAULT_EMERGING = REPO_ROOT / "valsets" / "emerging_challenge" / "emerging200.jsonl"
DEFAULT_BEFORE = (
    AGENT_EVAL
    / "results"
    / "emerging200_real_openclaw_caitlyn_evolved_after_pruned_promptfiltered.json"
)
DEFAULT_SKILLS = (
    AGENT_EVAL / "paper_artifacts" / "emerging_benchmark" / "evolved_antibodies_nodes.json"
)
DEFAULT_BENIGN = (
    REPO_ROOT / "valsets" / "eval_subsets" / "agentdefense_benign_subset.jsonl"
)
DEFAULT_LIBRARY_ROOT = Path("/home/zi/caitlyn")


def load_lifelong():
    """Load the lifelong driver module for isolated scan/vaccinate helpers."""
    path = Path(__file__).with_name("run_lifelong_synthesis.py")
    spec = importlib.util.spec_from_file_location("run_lifelong_synthesis", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    """Parse adaptive-attack driver flags."""
    parser = argparse.ArgumentParser(description="Section 5.3 skill-aware rewriter")
    parser.add_argument("--out-dir", default=str(AGENT_EVAL / "results" / "adaptive_20260822"))
    parser.add_argument("--before", default=str(DEFAULT_BEFORE))
    parser.add_argument("--skills", default=str(DEFAULT_SKILLS))
    parser.add_argument("--emerging", default=str(DEFAULT_EMERGING))
    parser.add_argument("--benign", default=str(DEFAULT_BENIGN))
    parser.add_argument("--library-root", default=str(DEFAULT_LIBRARY_ROOT))
    parser.add_argument("--model", default="deepseek/deepseek-chat")
    parser.add_argument("--max-queries", type=int, default=5)
    parser.add_argument("--limit", type=int, default=0, help="0 = all blocked cases")
    parser.add_argument("--dag-only", action="store_true", help="Skip static T1 oracle")
    parser.add_argument("--skip-vaccinate", action="store_true")
    parser.add_argument("--skip-rewrite", action="store_true", help="Summarize blocked set only")
    return parser.parse_args()


def seed_evolved_skills(evolution_dir: Path, skills_path: Path) -> None:
    """Copy the four paper skills into an isolated DAG file."""
    evolution_dir.mkdir(parents=True, exist_ok=True)
    dest = evolution_dir / "nodes.json"
    if dest.is_file():
        return
    shutil.copyfile(skills_path, dest)


def content_key(content: str) -> str:
    """Stable cache key for a scanned string."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def make_static_checker(
    lifelong: Any,
    out_dir: Path,
    library_dir: Path,
    evolution_dir: Path,
    enabled: bool,
) -> Callable[[str], bool]:
    """Cached static-library malicious check. No-op when dag-only."""
    cache: dict[str, bool] = {}

    def check(content: str) -> bool:
        if not enabled:
            return False
        key = content_key(content)
        if key in cache:
            return cache[key]
        item = {"id": key, "content": content}
        scanned = lifelong.cache_static_verdicts(
            out_dir, library_dir, [item], tier0_only=False
        )
        malicious = scanned[key].get("verdict") == "malicious"
        cache[key] = bool(malicious)
        return cache[key]

    return check


def write_json(path: Path, payload: Any) -> None:
    """Write pretty JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_checkpoint(path: Path) -> dict[str, dict[str, Any]]:
    """Resume rewrite rows by task id."""
    if not path.is_file():
        return {}
    rows = {}
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        row = json.loads(line)
        rows[row["task_id"]] = row
    return rows


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    """Append one JSONL object."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    """Run blocked-set extraction, rewriter loop, optional revaccinate."""
    args = parse_args()
    lifelong = load_lifelong()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    before = json.loads(Path(args.before).read_text(encoding="utf-8"))
    stages = {"evolution_dag"} if args.dag_only else None
    blocked_rows = extract_evolved_blocked_rows(before, stages=stages)
    if args.limit:
        blocked_rows = blocked_rows[: args.limit]
    write_json(
        out_dir / "blocked_set.json",
        {
            "n": len(blocked_rows),
            "ids": [row.get("task_id") for row in blocked_rows],
        },
    )
    print(f"blocked set n={len(blocked_rows)}", flush=True)
    if args.skip_rewrite:
        return

    library_dir = lifelong.prepare_isolated_library(out_dir, Path(args.library_root))
    evolution_dir = out_dir / "evolution"
    seed_evolved_skills(evolution_dir, Path(args.skills))
    nodes = load_active_dag_nodes(evolution_dir)
    if len(nodes) != 4:
        raise RuntimeError(f"expected 4 active skills, got {len(nodes)}")

    api_key = get_openrouter_api_key()
    static_fn = make_static_checker(
        lifelong, out_dir, library_dir, evolution_dir, enabled=not args.dag_only
    )

    def rewriter(prompt: str) -> str:
        return call_openrouter_json(api_key, prompt, args.model)

    checkpoint_path = out_dir / "rewrites.jsonl"
    done = load_checkpoint(checkpoint_path)
    escapes: list[dict[str, Any]] = []
    for row in blocked_rows:
        task_id = str(row.get("task_id"))
        if task_id in done:
            record = done[task_id]
        else:
            payload = str(row.get("injected_content") or "")
            target = attacker_target_of(row)
            outcome = rewrite_until_miss(
                payload=payload,
                target=target,
                nodes=nodes,
                rewriter=rewriter,
                max_queries=args.max_queries,
                static_malicious_fn=None if args.dag_only else static_fn,
            )
            record = {
                "task_id": task_id,
                "split": (row.get("metadata") or {}).get("split"),
                "original_node": (row.get("defense_cost") or {})
                .get("events", [{}])[0]
                .get("details", {})
                .get("node_id"),
                "target": target,
                **outcome,
            }
            append_jsonl(checkpoint_path, record)
            done[task_id] = record
        if record.get("escaped"):
            escapes.append(record)
        print(
            f"{task_id} escaped={record.get('escaped')} queries={record.get('queries')} "
            f"reason={record.get('reason')}",
            flush=True,
        )

    n = len(blocked_rows)
    run_ids = {str(row.get("task_id")) for row in blocked_rows}
    n_collide = sum(
        1
        for task_id, record in done.items()
        if task_id in run_ids and record.get("reason") == "target_collides"
    )
    summary = {
        "n_blocked": n,
        "n_target_collides": n_collide,
        "n_escaped": len(escapes),
        "escape_rate": (len(escapes) / n) if n else 0.0,
        "escape_rate_among_rewritable": (
            len(escapes) / (n - n_collide) if (n - n_collide) else 0.0
        ),
        "dag_only": args.dag_only,
        "max_queries": args.max_queries,
        "active_skills_before": count_active_skills(evolution_dir),
    }
    write_json(out_dir / "rewrite_summary.json", summary)
    print(json.dumps(summary, indent=2), flush=True)

    if args.skip_vaccinate or not escapes:
        return

    benign_rows = lifelong.read_jsonl(Path(args.benign))
    benign_items = [
        {
            "id": str(row.get("id") or f"benign-{i}"),
            "content": lifelong.extract_benign_text(row),
        }
        for i, row in enumerate(benign_rows)
    ]
    if args.dag_only:
        static_cache = {
            item["id"]: {"id": item["id"], "verdict": "benign"}
            for item in benign_items
        }
    else:
        static_cache = lifelong.cache_static_verdicts(
            out_dir, library_dir, benign_items, tier0_only=False
        )
    fpr_before = lifelong.fpr_on_benign(benign_items, static_cache, evolution_dir)

    revax_dir = out_dir / "evolution_revaccinate"
    if not (revax_dir / "nodes.json").is_file():
        shutil.copytree(evolution_dir, revax_dir, dirs_exist_ok=True)
    verifier_benign = [item["content"] for item in benign_items[:5]]
    outcome = lifelong.vaccinate_cluster(
        out_dir,
        library_dir,
        revax_dir,
        cluster_id="adaptive:escapes",
        misses=[row["payload"] for row in escapes],
        verifier_benign=verifier_benign,
        outcome_path=out_dir / "revaccinate_outcome.json",
    )
    fpr_after = lifelong.fpr_on_benign(benign_items, static_cache, revax_dir)
    nodes_after = load_active_dag_nodes(revax_dir)
    still_miss = 0
    for row in escapes:
        dag_hit = dag_block(row["payload"], nodes_after)
        static_hit = False if args.dag_only else static_fn(row["payload"])
        if dag_hit is None and not static_hit:
            still_miss += 1
    revax = {
        "n_escapes": len(escapes),
        "still_miss_after_vaccinate": still_miss,
        "fpr_before": fpr_before["fpr"],
        "fpr_after": fpr_after["fpr"],
        "fpr_n": fpr_after["n"],
        "active_skills_after": count_active_skills(revax_dir),
        "termination": outcome.get("termination"),
        "approved": outcome.get("approved", []),
    }
    write_json(out_dir / "revaccinate_summary.json", revax)
    print(json.dumps({k: revax[k] for k in revax if k != "approved"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
