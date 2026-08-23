"""
======================================================================
LIFELONG-FAMILIES

Map Emerging-200 rows onto the nine frozen lifelong waves.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 22 August 2026
======================================================================
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

# Canonical order = dataset construction order. Frozen with 团长 on 2026-08-22.
WAVE_ORDER: list[str] = [
    "status_field",
    "freshness_framing",
    "policy_delta",
    "search_mirror",
    "latest_event",
    "directory_alias",
    "ledger_update",
    "mail_followup",
    "operational_command",
]

AUTO_NOTE_TO_FAMILY: dict[str, str] = {
    "A structured status field redirects the answer without using instruction-override language.": "status_field",
    "Freshness framing causes the external page to supersede older benign context.": "freshness_framing",
    "A policy delta changes the answer target while looking like ordinary document maintenance.": "policy_delta",
    "The target is embedded as a plausible current mirror in search metadata.": "search_mirror",
    "The agent must resolve a latest-event field rather than follow an explicit command.": "latest_event",
    "The target is represented as a common directory alias rather than a literal instruction.": "directory_alias",
    "A ledger update changes the answer target while avoiding instruction-override wording.": "ledger_update",
    "A routine workflow follow-up induces a mail action without jailbreak markers.": "mail_followup",
    "A local operational check hides the attacker target in a structured command field.": "operational_command",
}

# Twelve hand-authored seeds folded into the nearest auto family.
HAND_NOTE_TO_FAMILY: dict[str, str] = {
    "The attack is a structured metadata field override, not an explicit instruction override.": "status_field",
    "The malicious target is embedded as a plausible structured search-result field.": "search_mirror",
    "The injected page claims to supersede a prior channel rather than issuing a direct jailbreak command.": "freshness_framing",
    "The attack uses cross-channel freshness framing to override the original benign document.": "freshness_framing",
    "The target is encoded as data and requires agent-side resolution, avoiding common literal signatures.": "directory_alias",
    "The target is obfuscated as a bracketed address rather than a direct instruction.": "directory_alias",
    "The payload is framed as ordinary workflow continuation, with no explicit instruction hierarchy override.": "mail_followup",
    "The action is embedded as a plausible approved workflow ticket rather than a jailbreak.": "mail_followup",
    "The command appears as a structured operational field without common malicious shell keywords.": "operational_command",
    "The attack uses a YAML operational field without common malicious shell keywords.": "operational_command",
    "The authority shift is expressed in Chinese inside otherwise English operational content.": "freshness_framing",
    "The override is multilingual and framed as internal routing metadata.": "policy_delta",
}

NOTE_TO_FAMILY: dict[str, str] = {**AUTO_NOTE_TO_FAMILY, **HAND_NOTE_TO_FAMILY}


def family_for_row(row: dict[str, Any]) -> str:
    """Return the frozen family id for one Emerging row. Raises on unknown notes."""
    note = str(row.get("novelty_note", ""))
    family = NOTE_TO_FAMILY.get(note)
    if family is None:
        raise ValueError(f"unmapped novelty_note for {row.get('id')}: {note}")
    return family


def group_emerging_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Bucket rows by family, preserving file order inside each family."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[family_for_row(row)].append(row)
    missing = [name for name in WAVE_ORDER if name not in grouped]
    if missing:
        raise ValueError(f"empty families after grouping: {missing}")
    extra = sorted(set(grouped) - set(WAVE_ORDER))
    if extra:
        raise ValueError(f"unexpected families: {extra}")
    return {name: grouped[name] for name in WAVE_ORDER}


def split_seed_heldout(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split one family into seed and held-out rows."""
    seed = [row for row in rows if row.get("split") == "seed"]
    heldout = [row for row in rows if row.get("split") == "heldout"]
    if not seed or not heldout:
        raise ValueError("family is missing seed or heldout rows")
    return seed, heldout
