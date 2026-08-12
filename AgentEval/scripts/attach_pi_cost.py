#!/usr/bin/env python3
"""
======================================================================
ATTACH-PI-COST

Attach real per-case agent usage and dollar cost to result files for the
pi agent. pi stores one JSONL session per run under
~/.pi/agent/sessions/--workspace-- in the container; each assistant
message carries usage and cost, and the first user message carries the
full prompt text. Joining on the prompt gives an exact mapping.

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
SESSIONS_DIR = "/root/.pi/agent/sessions/--workspace--"


def dump_sessions() -> list[dict]:
    """Parse pi session JSONL files and return prompt -> usage records."""
    script = f"""
import json, glob, os
out = []
for path in glob.glob('{SESSIONS_DIR}/*.jsonl'):
    prompt = None
    usage = {{'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0,
              'reasoning': 0, 'totalTokens': 0,
              'cost_input': 0.0, 'cost_output': 0.0, 'cost_total': 0.0}}
    session_id = None
    for line in open(path, encoding='utf-8'):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        t = rec.get('type')
        if t == 'session':
            session_id = rec.get('id')
        elif t == 'message':
            msg = rec.get('message', {{}})
            if msg.get('role') == 'user' and prompt is None:
                for part in msg.get('content', []):
                    if part.get('type') == 'text' and part.get('text'):
                        prompt = part['text']
                        break
            elif msg.get('role') == 'assistant':
                u = msg.get('usage') or {{}}
                c = u.get('cost') or {{}}
                for k in ('input','output','cacheRead','cacheWrite','reasoning','totalTokens'):
                    usage[k] = usage.get(k, 0) + int(u.get(k, 0) or 0)
                usage['cost_input'] += float(c.get('input', 0) or 0)
                usage['cost_output'] += float(c.get('output', 0) or 0)
                usage['cost_total'] += float(c.get('total', 0) or 0)
    if prompt:
        out.append({{
            'session_id': session_id or os.path.basename(path),
            'prompt': prompt,
            'usage': usage,
        }})
print(json.dumps(out, ensure_ascii=False))
"""
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "python3", "-c", script],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pi session dump failed: {result.stderr[:500]}")
    return json.loads(result.stdout.strip().splitlines()[-1])


def attach(path: str, sessions: list[dict]) -> dict:
    """Join sessions to results by exact prompt text and enrich them."""
    by_prompt: dict[str, dict] = {}
    for s in sessions:
        by_prompt.setdefault(s["prompt"], s)

    data = json.load(open(path, encoding="utf-8"))
    matched = unmatched = 0
    for r in data["results"]:
        session = by_prompt.get(r.get("prompt", ""))
        if session is None:
            unmatched += 1
            continue
        u = session["usage"]
        r["agent_usage"] = {
            "session_id": session["session_id"],
            "cost_usd": u["cost_total"],
            "tokens_input": u["input"],
            "tokens_output": u["output"],
            "tokens_reasoning": u["reasoning"],
            "tokens_cache_read": u["cacheRead"],
            "tokens_cache_write": u["cacheWrite"],
            "cost_input_usd": u["cost_input"],
            "cost_output_usd": u["cost_output"],
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
    print(f"pi sessions with user prompt: {len(sessions)}")
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
