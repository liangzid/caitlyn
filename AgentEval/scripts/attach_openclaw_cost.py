#!/usr/bin/env python3
"""
======================================================================
ATTACH-OPENCLAW-COST

Attach real per-case openclaw usage and dollar cost to result files.

openclaw writes one JSONL session per invocation under
/root/.openclaw/agents/<agent>/sessions inside the agent-eval container.
Each session contains the exact user prompt and per-assistant-message
usage (tokens + OpenRouter cost). We join result records to sessions by
the exact prompt text, so no agent call is re-run.

Usage:
    python3 scripts/attach_openclaw_cost.py results/eval/openclaw-none-*.json

Writes <input>.withcost.json next to each input.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 12 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

CONTAINER = "agent-eval"


_DUMP_SCRIPT = r"""
import glob, json, os

def user_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)

sessions = {}
for path in sorted(glob.glob("/root/.openclaw/agents/*/sessions/*.jsonl")):
    if path.endswith(".trajectory.jsonl"):
        plain = path[:-len(".trajectory.jsonl")] + ".jsonl"
        if os.path.exists(plain):
            continue
    current = None
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") == "session":
            sid = obj.get("id", "")
            current = sessions.setdefault(sid, {
                "session_id": sid,
                "prompt": "",
                "messages": 0,
                "input": 0,
                "output": 0,
                "cache_read": 0,
                "cache_write": 0,
                "reasoning": 0,
                "cost_usd": 0.0,
            })
            continue
        if current is None or obj.get("type") != "message":
            continue
        msg = obj.get("message", {})
        role = msg.get("role")
        if role == "user" and not current["prompt"]:
            current["prompt"] = user_text(msg.get("content", ""))
        elif role == "assistant":
            usage = msg.get("usage") or {}
            cost = usage.get("cost") or {}
            total = cost.get("total")
            if total is None:
                continue
            current["messages"] += 1
            current["input"] += int(usage.get("input", 0))
            current["output"] += int(usage.get("output", 0))
            current["cache_read"] += int(usage.get("cacheRead", 0))
            current["cache_write"] += int(usage.get("cacheWrite", 0))
            current["reasoning"] += int(usage.get("reasoningTokens", 0))
            current["cost_usd"] += float(total)

out = [s for s in sessions.values() if s["prompt"] and s["messages"] > 0]
print(json.dumps(out, ensure_ascii=False))
"""


def dump_sessions() -> list[dict]:
    """Dump (session_id, prompt, usage totals) from the container."""
    result = subprocess.run(
        ["docker", "exec", CONTAINER, "python3", "-c", _DUMP_SCRIPT],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"session dump failed: {result.stderr[:500]}")
    return json.loads(result.stdout.strip().splitlines()[-1])


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
        if not p.endswith(".json") or p.endswith(".withcost.json"):
            continue
        summary = attach(p, sessions)
        print(
            f"{summary['path']}: matched={summary['matched']} "
            f"unmatched={summary['unmatched']}"
        )


if __name__ == "__main__":
    main()
