"""
======================================================================
TEST-LIFELONG-PRUNE

Deterministic 5.1-style signature prune. Node ids are not hard-coded.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 23 August 2026
======================================================================
"""

from __future__ import annotations

from agent_eval.security.lifelong_prune import (
    is_generic_keyword_predicate,
    is_pathological_regex,
    prune_nodes,
    prune_reason,
)


def test_length_only_regex_is_pathological() -> None:
    """5.1 ab-015 class: match all long environment content."""
    assert is_pathological_regex(r"^[\s\S]{100,}$")
    assert is_pathological_regex(r".{80,}")
    assert not is_pathological_regex(r"ledger_update|chmod")


def test_exact_policy_is_generic() -> None:
    """Single common-English exact token is the 5.1 keyword class."""
    assert is_generic_keyword_predicate({"pattern": "policy", "type": "exact"})
    assert not is_generic_keyword_predicate({"pattern": "chmod", "type": "exact"})


def test_keyword_or_is_generic_but_tool_tokens_are_kept() -> None:
    """policy|scan|security drops. chmod|systemctl stays."""
    assert is_generic_keyword_predicate(
        {"pattern": r"\b(policy|scan|external|security)\b", "type": "regex"}
    )
    assert is_generic_keyword_predicate(
        {"pattern": r"(provide|share|send|forward|show|display)", "type": "regex"}
    )
    assert not is_generic_keyword_predicate(
        {
            "pattern": r"setfacl|chmod|chown|systemctl|service ",
            "type": "regex",
        }
    )
    assert not is_generic_keyword_predicate(
        {
            "pattern": r"(send_email|compose_email|write_email|email tool)",
            "type": "regex",
        }
    )


def test_benign_budget_drops_second_false_positive() -> None:
    """Pass epsilon=1, applied to the evaluation benign strings."""
    signature = {"pattern": "hello", "type": "exact", "label": "hi"}
    benign = ["hello world", "hello again", "unrelated"]
    assert prune_reason(signature, benign) == "benign_over_budget"


def test_empty_node_becomes_dormant() -> None:
    """A node with only over-broad signatures is deactivated, not deleted."""
    nodes = [
        {
            "id": "ab-test-001",
            "status": "active",
            "signatures": [
                {"pattern": "policy", "type": "exact", "label": "policy_token"},
            ],
        }
    ]
    pruned, dropped = prune_nodes(nodes, benign_texts=["unrelated"])
    assert pruned[0]["status"] == "dormant"
    assert pruned[0]["signatures"] == []
    reasons = {row["reason"] for row in dropped}
    assert "generic_keyword" in reasons
    assert "node_empty" in reasons
