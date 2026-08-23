"""
======================================================================
LIFELONG-DAG

Match active System II signatures the same way 5.1 CaitlynEvolvedDefense
does: regex (ignore-case) or exact substring. Isolated evolution dir only.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 22 August 2026
======================================================================
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def load_dag_document(evolution_dir: Path) -> dict[str, Any]:
    """Load the raw nodes.json document. Missing file is an empty graph."""
    nodes_path = evolution_dir / "nodes.json"
    if not nodes_path.is_file():
        return {"nodes": []}
    data = json.loads(nodes_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return {"nodes": []}
    nodes = data.get("nodes", [])
    if not isinstance(nodes, list):
        data["nodes"] = []
    return data


def load_dag_nodes(evolution_dir: Path) -> list[dict[str, Any]]:
    """Load every node, including dormant and archived."""
    return [
        node
        for node in load_dag_document(evolution_dir).get("nodes", [])
        if isinstance(node, dict)
    ]


def load_active_dag_nodes(evolution_dir: Path) -> list[dict[str, Any]]:
    """Load active nodes from <evolution_dir>/nodes.json. Missing file is empty."""
    return [node for node in load_dag_nodes(evolution_dir) if node.get("status") == "active"]


def signature_matches(pattern: str, sig_type: str, content: str) -> bool:
    """Match one signature the same way 5.1 CaitlynEvolvedDefense does."""
    if not pattern:
        return False
    if sig_type == "regex":
        try:
            return re.search(pattern, content, re.IGNORECASE) is not None
        except re.error:
            return False
    return pattern in content


def match_active_dag_signature(
    content: str,
    nodes: list[dict[str, Any]],
) -> dict[str, str] | None:
    """Return the first active signature that hits content, else None."""
    for node in nodes:
        if node.get("status") not in (None, "active"):
            continue
        for sig in node.get("signatures", []):
            pattern = str(sig.get("pattern", ""))
            sig_type = str(sig.get("type", ""))
            label = str(sig.get("label", pattern))
            if not signature_matches(pattern, sig_type, content):
                continue
            return {
                "node_id": str(node.get("id", "")),
                "label": label,
                "type": sig_type or "exact",
            }
    return None


def count_active_skills(evolution_dir: Path) -> int:
    """Number of active DAG nodes."""
    return len(load_active_dag_nodes(evolution_dir))
