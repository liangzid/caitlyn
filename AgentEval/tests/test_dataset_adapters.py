"""
======================================================================
TEST-DATASET-ADAPTERS

Unit tests for the four main-table dataset adapters:
AgentDojo / ASPI / SafeClawBench subset loaders and the shared JSONL
reader that must survive Unicode line separators inside records.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

from pathlib import Path

from agent_eval.security.dataset_adapters import (
    _read_jsonl,
    attack_delivered,
    judge_semantic_safe_completion,
    load_agentdojo_subset,
    load_aspi_subset,
    load_safeclawbench_subset,
    parse_judge_yes_line,
)

ROOT = Path(__file__).resolve().parents[2]
EVAL_DIR = ROOT / "valsets" / "eval_subsets"


def test_read_jsonl_handles_unicode_line_separators(tmp_path: Path) -> None:
    """A record containing U+2028 must not be split by the loader."""
    path = tmp_path / "cases.jsonl"
    path.write_text(
        '{"id": "a"}\n'
        '{"id": "b", "text": "line1\u2028line2"}\n',
        encoding="utf-8",
    )
    rows = _read_jsonl(path)
    assert len(rows) == 2
    assert rows[1]["text"] == "line1\u2028line2"


def test_agentdojo_subset_loader() -> None:
    """Attacks carry real injected surfaces; benign rows stay clean."""
    cases = load_agentdojo_subset(
        attacks_path=EVAL_DIR / "agentdojo_subset.jsonl",
        injections_path=EVAL_DIR / "agentdojo_subset_injections.jsonl",
        benign_path=EVAL_DIR / "agentdojo_benign_tasks.jsonl",
        max_attacks=2,
        max_benign=1,
    )
    assert len(cases) == 3
    attacks = [c for c in cases if c.label == "injection"]
    benign = [c for c in cases if c.label == "benign"]
    assert len(attacks) == 2 and len(benign) == 1
    for c in attacks:
        assert c.injected_tool == "read_file"
        assert c.injected_content
        assert c.metadata["suite"] in {"workspace", "travel", "banking", "slack"}
        assert c.metadata["surface_types"]
        listing = [t for t in c.tool_responses if t.tool_name == "list_directory"]
        assert listing and "files" in listing[0].content


def test_aspi_subset_loader() -> None:
    """One ASPI row yields 1 benign + 3 operator attacks; the injected
    clarification response is embedded in the reconstructed prompt."""
    cases = load_aspi_subset(EVAL_DIR / "aspi_subset.jsonl", max_rows=1)
    assert len(cases) == 4
    attacks = [c for c in cases if c.label == "injection"]
    benign = [c for c in cases if c.label == "benign"]
    assert len(attacks) == 3 and len(benign) == 1
    for c in attacks:
        assert c.injected_content in c.problem_statement
        assert c.metadata["condition"] == "clarif_user"
        assert c.metadata["operator"] in {"HR", "GS", "CP"}
        assert c.metadata["failure_mode"]
    assert benign[0].metadata["condition"] == "clarif_benign"


def test_safeclawbench_subset_loader() -> None:
    """SafeClawBench cases carry their success predicate as ground truth."""
    cases = load_safeclawbench_subset(
        EVAL_DIR / "safeclawbench_subset.jsonl", max_cases=2
    )
    assert len(cases) == 2
    for c in cases:
        assert c.label == "injection"
        assert c.expected_compromise_action
        assert c.safe_behavior
        assert c.attack_template in {"ADI", "DPI", "IPI", "MEX", "MPI", "TRI"}
        assert c.metadata["attack_type"] == c.attack_template
        assert c.metadata["lifecycle_stage"] in {
            "input", "decision", "inference", "execution",
        }


def test_safe_completion_judge_is_importable() -> None:
    """The benchmark utility symbol must remain available at import time."""
    assert callable(judge_semantic_safe_completion)


def test_parse_judge_yes_line_uses_first_token() -> None:
    """Only an affirmative first token counts as a positive verdict."""
    assert parse_judge_yes_line("YES | safe behavior completed") is True
    assert parse_judge_yes_line(" no | unsafe or incomplete") is False


def test_attack_delivered_channel_aware() -> None:
    """Tool-channel delivery uses the MCP audit; prompt-channel datasets
    are delivered by construction."""
    assert attack_delivered({
        "source_dataset": "agentdojo",
        "mcp_tool_calls": [{"injection_served": True}],
    }) is True
    assert attack_delivered({
        "source_dataset": "agentdojo",
        "mcp_tool_calls": [{"injection_served": False}],
    }) is False
    assert attack_delivered({
        "source_dataset": "aspi", "mcp_tool_calls": [],
    }) is True
    assert attack_delivered({
        "source_dataset": "safeclawbench", "mcp_tool_calls": [],
    }) is True
    assert attack_delivered({
        "source_dataset": "agentdojo",
        "injection_delivered": False,
        "mcp_tool_calls": [{"injection_served": True}],
    }) is False
    assert attack_delivered({
        "source_dataset": "aspi",
        "injection_delivered": True,
        "mcp_tool_calls": [],
    }) is True
