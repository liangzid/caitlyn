#!/usr/bin/env python3
"""
======================================================================
ATTACH-PI-COST

Attach real per-case pi usage and dollar cost to result files.

pi writes one JSONL session per invocation under
/root/.pi/agent/sessions/--workspace-- inside the agent-eval container.
Each session contains the exact user prompt and per-assistant-message
usage (tokens + OpenRouter cost). We join result records to sessions by
the exact prompt text, so no agent call is re-run.

Usage:
    python3 scripts/attach_pi_cost.py results/eval/pi-none-*.json

Writes <input>.withcost.json next to each input.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 11 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

CONTAINER = "agent-eval"
SESSIONS_GLOB = "/root/.pi/agent/sessions/--workspace--/*.jsonl"


def _empty_usage() -> dict:
    """Return a zeroed usage accumulator for one session."""
    return {
        "messages": 0,
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "reasoning": 0,
        "cost_usd": 0.0,
    }


def _add_usage(acc: dict, usage: dict) -> None:
    """Accumulate one assistant message's usage into the session total."""
    cost = usage.get("cost", {}) or {}
    acc["messages"] += 1
    acc["input"] += int(usage.get("input", 0))
    acc["output"] += int(usage.get("output", 0))
    acc["cache_read"] += int(usage.get("cacheRead", 0))
    acc["cache_write"] += int(usage.get("cacheWrite", 0))
    acc["reasoning"] += int(usage.get("reasoning", 0))
    acc["cost_usd"] += float(cost.get("total", 0) or 0)


def _user_text(content: list | str) -> str:
    """Extract plain text from a pi message content field."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


def dump_sessions() -> list[dict]:
    """Dump (session_id, prompt, usage totals) from the container."""
    result = subprocess.run(
        ["docker", "exec", CONTAINER, "sh", "-lc", f"cat {SESSIONS_GLOB}"],
        capture_output=True, text=True, timeout=900,
    )
    if result.returncode != 0:
        raise RuntimeError(f"session dump failed: {result.stderr[:500]}")

    sessions: dict[str, dict] = {}
    current: dict | None = None
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "session":
            current = {
                "session_id": obj.get("id", ""),
                "prompt": "",
                "usage": _empty_usage(),
                "timestamp": obj.get("timestamp", ""),
            }
            sessions[current["session_id"]] = current
            continue
        if current is None or obj.get("type") != "message":
            continue
        msg = obj.get("message", {})
        role = msg.get("role")
        if role == "user" and not current["prompt"]:
            current["prompt"] = _user_text(msg.get("content", ""))
        elif role == "assistant" and msg.get("usage"):
            _add_usage(current["usage"], msg["usage"])

    return [
        {
            "session_id": s["session_id"],
            "prompt": s["prompt"],
            "timestamp": s["timestamp"],
            **s["usage"],
        }
        for s in sessions.values()
        if s["prompt"] and s["usage"]["messages"] > 0
    ]


def attach(path: str, sessions: list[dict]) -> dict:
    """Join sessions to results by exact prompt text and enrich them."""
    by_prompt: dict[str, dict] = {}
    for s in sessions:
        by_prompt.setdefault(s["prompt"], s)

    data = json.load(open(path, encoding="utf-8"))
    matched = unmatched = 0
    for r in data["results"]:
        prompt = r.get("prompt", "")
        session = by_prompt.get(prompt)
        if session is None:
            unmatched += 1
            continue
        r["agent_usage"] = {
            "session_id": session["session_id"],
            "cost_usd": round(session["cost_usd"], 8),
            "tokens_input": session["input"],
            "tokens_output": session["output"],
            "tokens_reasoning": session["reasoning"],
            "tokens_cache_read": session["cache_read"],
            "tokens_cache_write": session["cache_write"],
            "tokens_total": (
                session["input"] + session["output"]
                + session["cache_read"] + session["cache_write"]
                + session["reasoning"]
            ),
            "messages": session["messages"],
            "timestamp": session["timestamp"],
        }
        matched += 1

    out_path = Path(path + ".withcost.json")
    out_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"path": path, "matched": matched, "unmatched": unmatched}


def main() -> None:
    """Attach usage to every result file and print a summary."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()
    sessions = dump_sessions()
    print(f"sessions with prompt + usage: {len(sessions)}")
    for p in args.paths:
        if not p.endswith(".json"):
            continue
        summary = attach(p, sessions)
        print(
            f"{summary['path']}: matched={summary['matched']} "
            f"unmatched={summary['unmatched']}"
        )


if __name__ == "__main__":
    main()
