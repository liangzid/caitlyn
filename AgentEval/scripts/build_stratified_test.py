#!/usr/bin/env python3
"""
======================================================================
BUILD-STRATIFIED-TEST

1. Builds the stratified 20-attack / 10-benign test set used for the
   no-defense ASR baseline, sampled deterministically from the AgentDojo
   valsets.

2. Strategy (agreed with 团长, 2026-08-03):
   - Attacks: 8 templates x 2 cases = 16, plus 1 extra case from each of
     the 4 primary templates (direct, ignore_previous, system_message,
     injecagent) = 20 attacks total.
   - Benign: 10 tasks sampled across domains.

3. Output: valsets/stratified_test/attacks.jsonl + benign.jsonl
   (original AgentDojo line format, so load_from_agentdojo_jsonl() can
   parse them unchanged).
======================================================================
"""

from __future__ import annotations

import json
import random
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
VALSETS = ROOT / "valsets"
OUT_DIR = VALSETS / "stratified_test"

SEED = 20260803
N_PER_TEMPLATE = 2
N_EXTRA_PRIMARY = 1
N_BENIGN = 10

PRIMARY_TEMPLATES = ["direct", "ignore_previous", "system_message", "injecagent"]
SECONDARY_TEMPLATES = [
    "important_instructions",
    "important_instructions_no_names",
    "important_instructions_wrong_user",
    "important_instructions_wrong_model",
]
ALL_TEMPLATES = PRIMARY_TEMPLATES + SECONDARY_TEMPLATES


def load_jsonl(path: Path) -> list[dict]:
    """Load a JSONL file into a list of dicts."""
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def pick_stratified_attacks(rng: random.Random) -> list[dict]:
    """Pick 20 attack records stratified by attack template."""
    attacks = load_jsonl(VALSETS / "attacks" / "agentdojo_all.jsonl")
    by_template: dict[str, list[dict]] = {}
    for attack in attacks:
        by_template.setdefault(attack.get("template", "unknown"), []).append(attack)

    missing = [t for t in ALL_TEMPLATES if t not in by_template]
    if missing:
        raise SystemExit(f"missing templates in dataset: {missing}")

    picked: list[dict] = []
    seen_ids: set[str] = set()

    for template in ALL_TEMPLATES:
        pool = by_template[template]
        rng.shuffle(pool)
        picked_in_template = 0
        for attack in pool:
            if attack["id"] in seen_ids:
                continue
            picked.append(attack)
            seen_ids.add(attack["id"])
            picked_in_template += 1
            if picked_in_template >= N_PER_TEMPLATE:
                break

    # Extra cases from the four primary templates to reach 20 attacks.
    for template in PRIMARY_TEMPLATES:
        for attack in by_template[template]:
            if attack["id"] not in seen_ids:
                picked.append(attack)
                seen_ids.add(attack["id"])
                break

    return picked


def pick_benign(rng: random.Random) -> list[dict]:
    """Pick 10 benign tasks across domains."""
    benign = load_jsonl(VALSETS / "benign" / "agent_tasks.jsonl")
    rng.shuffle(benign)
    return benign[:N_BENIGN]


def main() -> None:
    rng = random.Random(SEED)
    attacks = pick_stratified_attacks(rng)
    benign = pick_benign(rng)

    if len(attacks) != 20:
        raise SystemExit(f"expected 20 attacks, got {len(attacks)}")
    if len(benign) != N_BENIGN:
        raise SystemExit(f"expected {N_BENIGN} benign, got {len(benign)}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "attacks.jsonl", "w", encoding="utf-8") as f:
        for attack in attacks:
            f.write(json.dumps(attack, ensure_ascii=False) + "\n")
    with open(OUT_DIR / "benign.jsonl", "w", encoding="utf-8") as f:
        for task in benign:
            f.write(json.dumps(task, ensure_ascii=False) + "\n")

    template_counts = Counter(a.get("template", "unknown") for a in attacks)
    domain_counts = Counter(a.get("injection_domain", "?") for a in attacks)
    benign_domains = Counter(b.get("domain", "?") for b in benign)
    print("attacks:", len(attacks), "by template:", dict(template_counts))
    print("injection domains:", dict(domain_counts))
    print("benign:", len(benign), "by domain:", dict(benign_domains))
    print(f"written to {OUT_DIR}")


if __name__ == "__main__":
    main()
