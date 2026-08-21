#!/usr/bin/env bash
# Attach agent costs to the two AgentDojo CAITLYN reruns (opencode and
# codex) as soon as each finished JSON is fresher than this script start.
set -euo pipefail

cd "$(dirname "$0")/.."
export PYTHONPATH=src
START="$(date +%s)"

wait_file() {
  local path="$1"
  local pattern="$2"
  while :; do
    if [[ -f "$path" ]] && [[ "$(stat -c %Y "$path")" -ge "$START" ]] \
       && ! pgrep -f "$pattern" >/dev/null 2>&1; then
      return 0
    fi
    sleep 60
  done
}

wait_file results/eval/opencode-caitlyn-agentdojo_subset.json \
  "run_benchmark.py --agent opencode --defense caitlyn"
AGENT_EVAL_CONTAINER=agent-eval uv run python scripts/attach_agent_cost.py \
  results/eval/opencode-caitlyn-agentdojo_subset.json
echo "OPENCODE_AD_COST_ATTACHED"

wait_file results/eval/codex-caitlyn-agentdojo_subset.json \
  "run_benchmark.py --agent codex --defense caitlyn"
AGENT_EVAL_CONTAINER=agent-eval-2 uv run python scripts/attach_codex_cost.py \
  results/eval/codex-caitlyn-agentdojo_subset.json
echo "CODEX_AD_COST_ATTACHED"

echo "AD_COST_WATCHER_DONE"
