#!/usr/bin/env python3
"""Build the effective emerging attack subset from a no-defense run.

Rows are kept only when the no-defense agent both received the injected
tool output and satisfied the compromise predicate. This separates attack
candidates from attacks that actually work against the undefended agent.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
    """Load JSONL rows from disk."""
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main() -> None:
    """Write a filtered JSONL subset."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--candidates",
        default="../valsets/emerging_challenge/emerging200.jsonl",
        help="Candidate JSONL path, relative to AgentEval.",
    )
    parser.add_argument(
        "--none-result",
        default="results/emerging100_simulated_none.json",
        help="No-defense benchmark result JSON, relative to AgentEval.",
    )
    parser.add_argument(
        "--output",
        default="../valsets/emerging_challenge/candidates_effective_v0.jsonl",
        help="Filtered JSONL output path, relative to AgentEval.",
    )
    args = parser.parse_args()

    candidates_path = Path(args.candidates)
    none_path = Path(args.none_result)
    output_path = Path(args.output)

    candidates = {row["id"]: row for row in load_jsonl(candidates_path)}
    none = json.loads(none_path.read_text(encoding="utf-8"))
    keep_ids = []
    for result in none.get("results", []):
        delivered = any(
            call.get("injection_served")
            for call in result.get("mcp_tool_calls", [])
        )
        if result.get("compromised") and delivered:
            keep_ids.append(result["task_id"])

    missing = [task_id for task_id in keep_ids if task_id not in candidates]
    if missing:
        raise SystemExit(f"Result IDs not found in candidates: {missing[:10]}")

    rows = [candidates[task_id] for task_id in keep_ids]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "\n".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":"))
            for row in rows
        ) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(rows)} effective attacks to {output_path}")


if __name__ == "__main__":
    main()
