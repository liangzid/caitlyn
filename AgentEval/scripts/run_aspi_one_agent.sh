#!/usr/bin/env bash
# Run the ASPI-S full-prompt column for one agent (8 defenses) and attach
# costs. Invoked directly with positional args:
#   run_aspi_one_agent.sh <agent> <container> <mcp-port>
set -euo pipefail

agent="$1"
container="$2"
port="$3"
cd "$(dirname "$0")/.."
export PYTHONPATH=src
export PYTHONUNBUFFERED=1

MODEL="${MODEL:-deepseek/deepseek-chat}"
TIMEOUT="${TIMEOUT:-180}"
OUTDIR="${OUTDIR:-results/eval}"
START_EPOCH="$(python3 -c 'import time; print(int(time.time()))')"
log="$OUTDIR/${agent}_aspi_fullprompt.log"

echo "ASPI_START $agent container=$container port=$port $(date -Is)" > "$log"
for defense in none regex_guard llm_judge llm_judge_fewshot spotlighting tool_filter pi_detector caitlyn; do
  echo "CELL $agent $defense aspi_subset" >> "$log"
  AGENT_EVAL_CONTAINER="$container" \
  uv run python run_matrix.py \
    --agent "$agent" --defense "$defense" --datasets aspi_subset \
    --model "$MODEL" --mcp-port "$port" --timeout "$TIMEOUT" --outdir "$OUTDIR" \
    >> "$log" 2>&1 || echo "CELL_FAIL $agent $defense aspi_subset rc=$?" >> "$log"
done

paths=()
for defense in none regex_guard llm_judge llm_judge_fewshot spotlighting tool_filter pi_detector caitlyn; do
  paths+=("$OUTDIR/${agent}-${defense}-aspi_subset.json")
done
case "$agent" in
  opencode) AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_agent_cost.py "${paths[@]}" ;;
  pi)       AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_pi_cost.py "${paths[@]}" ;;
  hermes)   uv run python scripts/attach_hermes_cost.py "${paths[@]}" ;;
  openclaw) AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_openclaw_cost.py --since-epoch "$START_EPOCH" "${paths[@]}" ;;
  codex)    AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_codex_cost.py "${paths[@]}" ;;
esac >> "$log" 2>&1 || true
echo "ASPI_DONE $agent $(date -Is)" >> "$log"
