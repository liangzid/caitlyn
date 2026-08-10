#!/usr/bin/env python3
"""
======================================================================
BUILD-EVAL-SUBSETS

Build statistically grounded, stratified subsets of the four main-table
evaluation datasets agreed with 团长 (2026-08-10):

  1. AgentDojo (NeurIPS 2024, official v1, 629 security test cases)
  2. ASPI (ScaleAI 2026, 728 rows / 8-condition clarification injection)
  3. SafeClawBench (2026, 600 cases / 6 attack families)
  4. AgentDefense-Bench (2025, 35k+ MCP-native cases)

Sampling protocol:
  - deterministic seed (SEED);
  - proportional allocation per stratum (Hamilton largest remainder,
    minimum 1 per non-empty stratum);
  - AgentDefense-Bench is filtered to injection-relevant sources and
    categories (the full relevant population, no random down-sampling),
    because Tier-0 scanning of the full corpus is cheap;
  - benign controls are kept in full (AgentDojo 97 user tasks,
    AgentDefense-Bench 250 benign tests).

Raw data is read from $AGENTDATA_DIR (default /tmp/agentdata) and the
subset files are written to valsets/eval_subsets/ together with a
provenance manifest (source, license, commit/SHA256, seed, strata).

Run:
    cd AgentEval && uv run python scripts/build_eval_subsets.py
======================================================================
"""

from __future__ import annotations

import hashlib
import json
import os
import random
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
AGENTDATA_DIR = Path(os.environ.get("AGENTDATA_DIR", "/tmp/agentdata"))
OUT_DIR = ROOT / "valsets" / "eval_subsets"
SEED = 20260810

# Injection-relevant sources in the consolidated AgentDefense-Bench tiers.
# REVIEW: scope boundary -- prompt injection / jailbreak / tool poisoning /
# encoding only; cyber/bio/malware/etc. harm domains are out of scope for
# CAITLYN's injection defense and are excluded by design.
ADB_RELEVANT_SOURCES = {
    "MCPSecBench",
    "MCPTox-ToolPoisoning",
    "jailbreak-classification",
    "ChatGPT-Jailbreak-Prompts",
    "ScaleAI/mhj",
}

# Injection-relevant subcategories of AgentDefense-Bench combined_attacks.json.
ADB_RELEVANT_SUBCATEGORIES = {
    "mcp_hidden_fields",
    "data_exfiltration",
    "jailbreak_prompt",
    "indirect_injection",
    "encoding_attack",
}
ADB_RESPONSE_PREFIX = "response_"

AGENTDOJO_PAIRS_FILE = "agentdojo_v1_pairs.jsonl"
AGENTDOJO_REPO_COMMIT = "089ed468cf3ed0322acc66b0211f26d9d90dbf60"
AGENTDOJO_PACKAGE_VERSION = "0.1.35"


def sha256(path: Path) -> str:
    """Return the SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    """Load a JSONL file into a list of dicts."""
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_json(path: Path) -> list[dict]:
    """Load a JSON file with a {tests|attacks: [...]} envelope into a list."""
    data = json.load(open(path, encoding="utf-8"))
    if isinstance(data, list):
        return data
    return data.get("tests") or data.get("attacks") or []


def proportional_allocation(counts: dict[str, int], target: int) -> dict[str, int]:
    """Allocate `target` items across strata proportionally (min 1 each).

    Uses the Hamilton largest-remainder method. Strata with no items get 0.
    """
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


def stratified_sample(
    items: list[dict], strata_key: str, target: int, seed: int
) -> list[dict]:
    """Deterministic proportional stratified sample keyed by `strata_key`."""
    rng = random.Random(seed)
    groups: dict[str, list[dict]] = {}
    for item in items:
        groups.setdefault(str(item.get(strata_key, "unknown")), []).append(item)
    allocation = proportional_allocation(
        {k: len(v) for k, v in groups.items()}, target
    )
    sampled: list[dict] = []
    for stratum, take in allocation.items():
        pool = groups[stratum]
        sampled.extend(rng.sample(pool, min(take, len(pool))))
    rng.shuffle(sampled)
    return sampled


def load_agentdojo(raw_dir: Path) -> tuple[list[dict], list[dict]]:
    """Load the pre-enumerated AgentDojo v1 pairs and benign user tasks."""
    records = load_jsonl(raw_dir / AGENTDOJO_PAIRS_FILE)
    attacks = [r for r in records if not r.get("__benign__")]
    benign = [r for r in records if r.get("__benign__")]
    for r in benign:
        r.pop("__benign__", None)
    return attacks, benign


def load_aspi(raw_dir: Path) -> list[dict]:
    """Load all ASPI rows (each row carries the 8-condition materials)."""
    rows: list[dict] = []
    for suite in ("banking", "slack", "travel", "workspace"):
        rows.extend(load_jsonl(raw_dir / "aspi" / "data" / f"{suite}.jsonl"))
    return rows


def load_safeclawbench(raw_dir: Path) -> list[dict]:
    """Load the 600 SafeClawBench cases."""
    return load_json(raw_dir / "safeclawbench" / "benchmark_v5_600.json")


def load_agentdefense(raw_dir: Path) -> tuple[list[dict], list[dict]]:
    """Load injection-relevant AgentDefense-Bench attacks and all benign."""
    attacks: list[dict] = []
    for tier in ("tier1_critical_tests", "tier2_high_tests", "tier3_medium_tests"):
        tests = load_json(raw_dir / "agentdefense" / "consolidated" / f"{tier}.json")
        for t in tests:
            if t.get("source") in ADB_RELEVANT_SOURCES:
                t = dict(t)
                t["source_file"] = f"consolidated/{tier}.json"
                attacks.append(t)

    dedicated = [
        ("attacks/encoding_attacks.json", load_json(raw_dir / "agentdefense" / "attacks" / "encoding_attacks.json")),
        ("attacks/mcpsecbench.json", load_json(raw_dir / "agentdefense" / "attacks" / "mcpsecbench.json")),
        ("attacks/novel_2024_2025.json", load_json(raw_dir / "agentdefense" / "attacks" / "novel_2024_2025.json")),
        ("attacks/combined_attacks.json", load_json(raw_dir / "agentdefense" / "attacks" / "combined_attacks.json")),
        ("tool_poisoning/tool_poisoning_attacks.json", load_json(raw_dir / "agentdefense" / "tool_poisoning" / "tool_poisoning_attacks.json")),
    ]
    for src, tests in dedicated:
        for t in tests:
            sub = str(t.get("subcategory", ""))
            if src == "attacks/combined_attacks.json" and not (
                sub in ADB_RELEVANT_SUBCATEGORIES
                or sub.startswith(ADB_RESPONSE_PREFIX)
            ):
                continue
            if src == "attacks/novel_2024_2025.json" and sub in {
                "ssrf",
                "xxe",
                "ssti",
            }:
                # Out of scope: web-application exploits, not prompt injection.
                continue
            t = dict(t)
            t["source_file"] = src
            attacks.append(t)

    # Drop control/benign rows that leaked into attack files.
    attacks = [
        t
        for t in attacks
        if not (
            t.get("is_benign") is True
            or t.get("category") == "benign"
            or t.get("expected") == "allowed"
        )
    ]

    # Deduplicate by id, keeping the first occurrence.
    seen: set[str] = set()
    deduped: list[dict] = []
    for t in attacks:
        tid = str(t.get("id", ""))
        if tid and tid in seen:
            continue
        if tid:
            seen.add(tid)
        deduped.append(t)

    benign = load_json(raw_dir / "agentdefense" / "consolidated" / "benign_tests.json")
    return deduped, benign


def write_jsonl(path: Path, items: list[dict]) -> None:
    """Write items as JSONL."""
    with open(path, "w", encoding="utf-8") as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def strata_counts(items: list[dict], key: str) -> dict[str, int]:
    """Return per-stratum counts for the manifest."""
    return dict(sorted(Counter(str(i.get(key, "unknown")) for i in items).items()))


def main() -> None:
    """Build the four subsets and write them with a provenance manifest."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        "created": "2026-08-10",
        "seed": SEED,
        "sampling_method": (
            "proportional stratified sampling with Hamilton largest-remainder "
            "allocation and a minimum of 1 per non-empty stratum; "
            "AgentDefense-Bench uses the full injection-relevant population"
        ),
        "wilson_95_ci_note": (
            "for p=0.5, n=250 gives a ~+/-6.2pp half-width; n=240 ~+/-6.3pp"
        ),
        "datasets": {},
    }

    # 1. AgentDojo: 629 pairs -> 250; benign: all 97 user tasks.
    ad_attacks, ad_benign = load_agentdojo(AGENTDATA_DIR)
    # Composite strata key: suite x injection task (27 strata).
    ad_subset = stratified_sample(
        [dict(r, **{"suite|injection_task_id": f"{r['suite']}|{r['injection_task_id']}"})
         for r in ad_attacks],
        "suite|injection_task_id", 250, SEED,
    )
    ad_strata = strata_counts(ad_subset, "suite|injection_task_id")
    for r in ad_subset:
        r.pop("suite|injection_task_id", None)
    write_jsonl(OUT_DIR / "agentdojo_subset.jsonl", ad_subset)
    write_jsonl(OUT_DIR / "agentdojo_benign_tasks.jsonl", ad_benign)
    manifest["datasets"]["agentdojo"] = {
        "source": "https://github.com/ethz-spylab/agentdojo",
        "commit": AGENTDOJO_REPO_COMMIT,
        "package_version": AGENTDOJO_PACKAGE_VERSION,
        "license": "MIT",
        "benchmark_version": "v1",
        "population": len(ad_attacks),
        "subset_size": len(ad_subset),
        "strata": ad_strata,
        "benign_tasks": len(ad_benign),
        "notes": "official 629 security test cases = user_task x injection_task pairs",
    }

    # 2. ASPI: 728 rows -> 31 rows (each row instantiates 8 conditions).
    aspi_rows = load_aspi(AGENTDATA_DIR)
    aspi_subset = stratified_sample(aspi_rows, "suite", 31, SEED)
    write_jsonl(OUT_DIR / "aspi_subset.jsonl", aspi_subset)
    manifest["datasets"]["aspi"] = {
        "source": "https://huggingface.co/datasets/ScaleAI/aspi",
        "license": "CC-BY-4.0",
        "population": len(aspi_rows),
        "subset_size": len(aspi_subset),
        "strata": strata_counts(aspi_subset, "suite"),
        "notes": (
            "each row carries materials for 8 ASPI conditions "
            "(state x channel x wrapper) and 3 injection operators"
        ),
    }

    # 3. SafeClawBench: 600 -> 240 (6 families x 40).
    scb = load_safeclawbench(AGENTDATA_DIR)
    scb_subset = stratified_sample(scb, "attack_type", 240, SEED)
    write_jsonl(OUT_DIR / "safeclawbench_subset.jsonl", scb_subset)
    manifest["datasets"]["safeclawbench"] = {
        "source": "https://huggingface.co/datasets/sairights/safeclawbench",
        "license": "MIT",
        "population": len(scb),
        "subset_size": len(scb_subset),
        "strata": strata_counts(scb_subset, "attack_type"),
    }

    # 4. AgentDefense-Bench: injection-relevant population + benign in full.
    adb_attacks, adb_benign = load_agentdefense(AGENTDATA_DIR)
    write_jsonl(OUT_DIR / "agentdefense_detection_subset.jsonl", adb_attacks)
    write_jsonl(OUT_DIR / "agentdefense_benign_subset.jsonl", adb_benign)
    manifest["datasets"]["agentdefense"] = {
        "source": "https://github.com/arunsanna/AgentDefense-Bench",
        "commit": "b5dfdf3c6cf33fb3c0b39865384b9ca833aa4183",
        "license": "Apache-2.0 (constituent sources retain their licenses)",
        "population_attacks": 35546,
        "relevant_population": len(adb_attacks),
        "subset_size": len(adb_attacks),
        "benign_size": len(adb_benign),
        "strata": strata_counts(adb_attacks, "source"),
        "notes": (
            "relevant = prompt injection/jailbreak/tool poisoning/encoding/"
            "exfiltration; out-of-scope harm domains excluded; expected block "
            "derives from is_benign==False or expected=='blocked' (dedicated "
            "files may use expected_action instead)"
        ),
    }

    # Provenance: raw source hashes.
    raw_hashes: dict[str, str] = {}
    raw_files = [
        AGENTDATA_DIR / AGENTDOJO_PAIRS_FILE,
        *sorted((AGENTDATA_DIR / "aspi" / "data").glob("*.jsonl")),
        AGENTDATA_DIR / "safeclawbench" / "benchmark_v5_600.json",
        *sorted((AGENTDATA_DIR / "agentdefense" / "consolidated").glob("*.json")),
        *sorted((AGENTDATA_DIR / "agentdefense" / "attacks").glob("*.json")),
        AGENTDATA_DIR / "agentdefense" / "tool_poisoning" / "tool_poisoning_attacks.json",
    ]
    for p in raw_files:
        if p.exists():
            raw_hashes[str(p.relative_to(AGENTDATA_DIR))] = sha256(p)
    manifest["raw_source_sha256"] = raw_hashes

    with open(OUT_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"wrote subsets to {OUT_DIR}")
    for name, info in manifest["datasets"].items():
        print(f"  {name}: subset={info['subset_size']} strata={len(info['strata'])}")


if __name__ == "__main__":
    main()
