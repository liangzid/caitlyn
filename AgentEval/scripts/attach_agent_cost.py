#!/usr/bin/env python3
"""
======================================================================
ATTACH-AGENT-COST

Attach the real per-case agent usage and dollar cost to result files by
matching opencode sessions (stored in the container's opencode.db) to
results through the exact prompt text.

The opencode session table records cost and token counts per session,
and the part table stores the user prompt verbatim. Joining on the
prompt gives an exact one-to-one mapping without re-running agents.

Usage:
    python3 scripts/attach_agent_cost.py results/eval/opencode-none-*.json

Writes <input>.withcost.json next to each input.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 10 August 2026
======================================================================
"""

from __future__ import annotations

import json
import argparse
import os
import subprocess
import sys
from pathlib import Path

CONTAINER = os.environ.get("AGENT_EVAL_CONTAINER", "agent-eval")
DB = "/root/.local/share/opencode/opencode.db"


def dump_sessions(start_ms: int) -> list[dict]:
    """Dump sessions (usage + user prompt text) from the container DB."""
    script = f"""
import sqlite3, json
con = sqlite3.connect('file:{DB}?mode=ro', uri=True)
cur = con.cursor()
rows = cur.execute(
    "select s.id, s.cost, s.tokens_input, s.tokens_output, "
    "s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write, "
    "p.data, m.data "
    "from session s join part p on p.session_id = s.id "
    "join message m on m.id = p.message_id "
    "where s.time_created >= ? order by s.time_created",
    ({start_ms},),
).fetchall()
out = {{}}
for sid, cost, tin, tout, trea, tcr, tcw, pdata, mdata in rows:
    try:
        pd = json.loads(pdata)
        md = json.loads(mdata)
    except Exception:
        continue
    if pd.get("type") != "text" or md.get("role") != "user":
        continue
    text = pd.get("text", "")
    try:
        # opencode stores the prompt JSON-encoded but keeps literal
        # newlines inside the string; strict=False accepts them.
        decoded = json.loads(text, strict=False)
        if isinstance(decoded, str):
            text = decoded
    except Exception:
        pass
    if not text or sid in out:
        continue
    out[sid] = {{
        "session_id": sid,
        "cost": cost,
        "tokens_input": tin,
        "tokens_output": tout,
        "tokens_reasoning": trea,
        "tokens_cache_read": tcr,
        "tokens_cache_write": tcw,
        "prompt": text,
    }}
print(json.dumps(list(out.values()), ensure_ascii=False))
"""
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "python3", "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"DB dump failed: {result.stderr[:500]}")
    return json.loads(result.stdout.strip().splitlines()[-1])


def attach(path: str, sessions: list[dict]) -> dict:
    """Join sessions to results by exact prompt text and enrich them."""
    by_prompt: dict[str, dict] = {}
    # KEYPOINT: last session wins so a later CAITLYN rerun is not
    # joined to an older baseline session with the same prompt.
    for s in sessions:
        by_prompt[s["prompt"]] = s

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
            "cost_usd": session["cost"],
            "tokens_input": session["tokens_input"],
            "tokens_output": session["tokens_output"],
            "tokens_reasoning": session["tokens_reasoning"],
            "tokens_cache_read": session["tokens_cache_read"],
            "tokens_cache_write": session["tokens_cache_write"],
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
    parser.add_argument("--start-ms", type=int, default=0)
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()
    start_ms = args.start_ms
    paths = args.paths
    sessions = dump_sessions(start_ms)
    print(f"sessions with user prompt: {len(sessions)}")
    for p in paths:
        if not p.endswith(".json"):
            continue
        summary = attach(p, sessions)
        print(
            f"{summary['path']}: matched={summary['matched']} "
            f"unmatched={summary['unmatched']}"
        )


if __name__ == "__main__":
    main()
