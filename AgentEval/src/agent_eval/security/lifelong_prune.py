"""
======================================================================
LIFELONG-PRUNE

Post-acceptance filter used by paper 5.1 and appendix app:synthesis-overfit.
System II Pass only sees five short verifier strings. Over-broad predicates
can still survive that check. This module drops them before the 5.2 table.

A signature is removed when any of:
  1. pathological / length-only regex (matches nearly all long content)
  2. generic lexical predicate (unanchored common-English token or OR)
  3. more than one hit on the evaluation benign pool (Pass epsilon=1,
     applied to the 250-string FPR set rather than the five verifier strings)

A node with no remaining signatures is set to dormant. Node ids are not
hard-coded. The generic-lexeme set is the 5.1 keyword-OR class.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 23 August 2026
======================================================================
"""

from __future__ import annotations

import copy
import re
from typing import Any

from agent_eval.security.lifelong_dag import signature_matches

# KEYPOINT-REVIEW: closed class for 5.1 "broad keyword matching". Technical
# tokens such as chmod / send_email are not in this set and are kept.
GENERIC_LEXEMES: frozenset[str] = frozenset(
    {
        "academic",
        "against",
        "all",
        "any",
        "attack",
        "attacks",
        "audit",
        "censorship",
        "complete",
        "constraints",
        "course",
        "display",
        "effective",
        "entire",
        "enterprise",
        "escalat",
        "escalate",
        "escalation",
        "ethical",
        "external",
        "filtering",
        "forward",
        "free",
        "full",
        "harmful",
        "help",
        "log",
        "logs",
        "method",
        "methodology",
        "output",
        "outputs",
        "patterns",
        "please",
        "policy",
        "prompt",
        "prompts",
        "provide",
        "research",
        "review",
        "scan",
        "security",
        "send",
        "share",
        "show",
        "social",
        "speech",
        "study",
        "supervisor",
        "system",
        "tool",
        "transcript",
        "transfer",
        "unredacted",
        "without",
    }
)

MAX_BENIGN_HITS = 1
LENGTH_ONLY_MIN = 80
_REGEX_META = re.compile(r"[\\[\]{}^$.*+/]")
_OPTIONAL_S = re.compile(r"s\?$")
_DOT_QUANT = re.compile(r"\.\{(\d+),(\d*)\}")


def is_pathological_regex(pattern: str) -> bool:
    """True for length-only or match-all character classes (5.1 ab-015 class)."""
    if re.search(r"\[\\s\\S\]|\[\\d\\D\]|\[\\w\\W\]", pattern):
        return True
    for match in _DOT_QUANT.finditer(pattern):
        if int(match.group(1)) >= LENGTH_ONLY_MIN:
            return True
    return False


def _normalize_word(token: str) -> str:
    """Lowercase one regex alternative piece and strip a trailing s?."""
    word = token.strip().lower()
    word = _OPTIONAL_S.sub("", word)
    return word.replace("?", "")


def keyword_alternatives(pattern: str) -> list[list[str]] | None:
    """Return word lists if the pattern is only a keyword disjunction.

    Patterns that require punctuation, paths, or other regex structure
    are treated as specific and return None.
    """
    stripped = pattern.strip().replace("\\b", "")
    while (
        stripped.startswith("(")
        and stripped.endswith(")")
        and stripped.count("(") == 1
        and stripped.count(")") == 1
    ):
        stripped = stripped[1:-1]
    if _REGEX_META.search(stripped):
        return None
    alternatives: list[list[str]] = []
    for piece in stripped.split("|"):
        words = [_normalize_word(part) for part in piece.split()]
        if not words:
            return None
        if any(not word.isalpha() or not (2 <= len(word) <= 16) for word in words):
            return None
        alternatives.append(words)
    return alternatives


def is_generic_keyword_predicate(signature: dict[str, Any]) -> bool:
    """True for an unanchored common-English token or a disjunction of those."""
    pattern = str(signature.get("pattern", "")).strip()
    sig_type = str(signature.get("type", "") or "exact")
    if sig_type != "regex":
        token = pattern.lower()
        return token.isalpha() and token in GENERIC_LEXEMES
    alternatives = keyword_alternatives(pattern)
    if alternatives is None:
        return False
    return all(all(word in GENERIC_LEXEMES for word in words) for words in alternatives)


def benign_hit_count(signature: dict[str, Any], benign_texts: list[str]) -> int:
    """How many benign strings this signature fires on."""
    pattern = str(signature.get("pattern", ""))
    sig_type = str(signature.get("type", "") or "exact")
    return sum(1 for text in benign_texts if signature_matches(pattern, sig_type, text))


def prune_reason(signature: dict[str, Any], benign_texts: list[str]) -> str | None:
    """Return the first prune reason, or None to keep the signature."""
    pattern = str(signature.get("pattern", ""))
    sig_type = str(signature.get("type", "") or "exact")
    if sig_type == "regex" and is_pathological_regex(pattern):
        return "pathological_regex"
    if is_generic_keyword_predicate(signature):
        return "generic_keyword"
    if benign_hit_count(signature, benign_texts) > MAX_BENIGN_HITS:
        return "benign_over_budget"
    return None


def prune_nodes(
    nodes: list[dict[str, Any]],
    benign_texts: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Copy nodes, drop over-broad signatures, dormant empty nodes.

    Returns (pruned_nodes, dropped_report).
    """
    pruned: list[dict[str, Any]] = []
    dropped: list[dict[str, str]] = []
    for original in nodes:
        node = copy.deepcopy(original)
        kept: list[dict[str, Any]] = []
        for signature in node.get("signatures", []):
            if not isinstance(signature, dict):
                continue
            reason = prune_reason(signature, benign_texts)
            if reason is None:
                kept.append(signature)
                continue
            dropped.append(
                {
                    "node_id": str(node.get("id", "")),
                    "label": str(signature.get("label", signature.get("pattern", ""))),
                    "reason": reason,
                }
            )
        node["signatures"] = kept
        if not kept and node.get("status") == "active":
            node["status"] = "dormant"
            dropped.append(
                {
                    "node_id": str(node.get("id", "")),
                    "label": "*",
                    "reason": "node_empty",
                }
            )
        pruned.append(node)
    return pruned, dropped
