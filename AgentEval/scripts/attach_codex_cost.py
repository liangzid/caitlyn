#!/usr/bin/env python3
"""
======================================================================
ATTACH-CODEX-COST

Attach real per-case agent token usage and dollar cost to result files
for the codex agent. codex stores one rollout JSONL per exec run under
~/.codex/sessions/YYYY/MM/DD in the container. The user prompt is stored
as an input_text part starting with "Task:", and cumulative token usage
is reported by event_msg/token_count records. Dollar cost is computed
with OpenRouter prices because codex rollouts do not record cost.

Usage:
    python3 scripts/attach_codex_cost.py results/eval/codex-*.json

Writes <input>.withcost.json next to each input.

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright (C) 2026, Zi Liang, all rights reserved.
    Created: 13 August 2026
======================================================================
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

CONTAINER = os.environ.get("AGENT_EVAL_CONTAINER", "agent-eval")
SESSIONS_ROOT = "/root/.codex/sessions"

# OpenRouter deepseek/deepseek-chat prices (USD per token), verified from
# https://openrouter.ai/api/v1/models on 2026-08-13.
PRICE_PROMPT = 0.0000002574
PRICE_COMPLETION = 0.0000010287


def dump_sessions() -> list[dict]:
    """Parse codex rollout JSONL files and return prompt -> usage records."""
    script = f"""
import json, glob
out = []
for p in sorted(glob.glob('{SESSIONS_ROOT}/2026/*/*/*.jsonl')):
    prompt = None
    usage = None
    for line in open(p, encoding='utf-8'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        payload = r.get('payload') or {{}}
        if payload.get('type') == 'token_count':
            info = payload.get('info') or {{}}
            if info.get('total_token_usage'):
                usage = info['total_token_usage']
        if prompt is None:
            def walk(o):
                if isinstance(o, dict):
                    if o.get('type') == 'input_text' and \\
                            str(o.get('text', '')).startswith('Task:'):
                        yield o['text']
                    for v in o.values():
                        yield from walk(v)
                elif isinstance(o, list):
                    for v in o:
                        yield from walk(v)
            texts = list(walk(r))
            if texts:
                prompt = texts[0]
    if prompt and usage:
        out.append({{'prompt': prompt, 'usage': usage}})
print(json.dumps(out, ensure_ascii=False))
"""
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "python3", "-c", script],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"codex session dump failed: {result.stderr[:500]}")
    return json.loads(result.stdout.strip().splitlines()[-1])


def to_cost(usage: dict) -> dict:
    """Convert codex token usage into an agent_usage record with USD cost."""
    tin = int(usage.get("input_tokens", 0) or 0)
    cached = int(usage.get("cached_input_tokens", 0) or 0)
    tout = int(usage.get("output_tokens", 0) or 0)
    trea = int(usage.get("reasoning_output_tokens", 0) or 0)
    # codex reports cached input as part of input_tokens; charge cache reads
    # at the prompt rate only when they are not already inside input_tokens.
    chargeable_input = max(tin - cached, 0)
    cost = chargeable_input * PRICE_PROMPT + tout * PRICE_COMPLETION
    return {
        "cost_usd": round(cost, 8),
        "tokens_input": tin,
        "tokens_output": tout,
        "tokens_reasoning": trea,
        "tokens_cache_read": cached,
        "tokens_cache_write": int(usage.get("cached_output_tokens", 0) or 0),
        "cost_input_usd": round(chargeable_input * PRICE_PROMPT, 8),
        "cost_output_usd": round(tout * PRICE_COMPLETION, 8),
    }


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
        session = by_prompt.get(r.get("prompt", ""))
        if session is None:
            unmatched += 1
            continue
        r["agent_usage"] = to_cost(session["usage"])
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
    print(f"codex sessions with prompt+usage: {len(sessions)}")
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
