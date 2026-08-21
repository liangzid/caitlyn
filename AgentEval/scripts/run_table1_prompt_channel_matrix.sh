#!/usr/bin/env bash
# Run the prompt-channel Table 1 cells (ASPI-S and SafeClawBench-S240) for
# all 5 agents x 8 defenses with the fixed harness, in parallel across 5
# containers, then attach per-agent costs.
#
# Also reruns the CAITLYN AgentDojo cell for pi/hermes/openclaw so every
# CAITLYN row uses the tuned (v3) detector prompt.
#
# Protocol: deepseek/deepseek-chat, merged-pair daemon on 9070, evolution
# off, ASPI/SCB prompt segments filtered through the defense.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/AgentEval"
cd "$EVAL"
export PYTHONPATH=src
export PYTHONUNBUFFERED=1

MODEL="${MODEL:-deepseek/deepseek-chat}"
TIMEOUT="${TIMEOUT:-180}"
OUTDIR="${OUTDIR:-results/eval}"
DEFENSES=(none regex_guard llm_judge llm_judge_fewshot spotlighting tool_filter pi_detector caitlyn)
DATASETS=(aspi_subset safeclawbench_subset)
START_EPOCH="$(python3 -c 'import time; print(int(time.time()))')"

# container / mcp port per agent. agent-eval-5 is codex's dedicated
# container so its session store stays isolated.
declare -A CONTAINERS=( [opencode]=agent-eval [pi]=agent-eval-2 [hermes]=agent-eval-3 [openclaw]=agent-eval-4 [codex]=agent-eval-5 )
declare -A PORTS=( [opencode]=9877 [pi]=9878 [hermes]=9880 [openclaw]=9881 [codex]=9882 )

# Back up the old ASPI/SCB result files so stale no-defense numbers are
# never mistaken for fresh runs.
BACKUP="$OUTDIR/backup_pre_prompt_channel_20260821"
mkdir -p "$BACKUP"
for agent in "${!CONTAINERS[@]}"; do
  for defense in "${DEFENSES[@]}"; do
    for dataset in "${DATASETS[@]}"; do
      f="$OUTDIR/${agent}-${defense}-${dataset}.json"
      if [[ -f "$f" ]] && [[ ! -f "$BACKUP/$(basename "$f")" ]]; then
        cp -p "$f" "$BACKUP/"
      fi
    done
  done
done

run_agent() {
  local agent="$1"
  local container="$2"
  local port="$3"
  local log="$OUTDIR/${agent}_prompt_channel_matrix.log"
  local cells=(none regex_guard llm_judge llm_judge_fewshot spotlighting tool_filter pi_detector caitlyn)
  local datasets=(aspi_subset safeclawbench_subset)
  # opencode's AgentDojo CAITLYN rerun (started before this matrix) still
  # owns MCP port 9877 on agent-eval; wait for it to release the port.
  if [[ "$agent" == "opencode" ]]; then
    while pgrep -f 'run_benchmark.py --agent opencode' >/dev/null 2>&1; do
      echo "WAIT opencode AD rerun holds port $port" >> "$log"
      sleep 60
    done
  fi
  echo "AGENT_START $agent container=$container port=$port $(date -Is)" > "$log"
  for defense in "${cells[@]}"; do
    for dataset in "${datasets[@]}"; do
      local out="$OUTDIR/${agent}-${defense}-${dataset}.json"
      echo "CELL $agent $defense $dataset" >> "$log"
      AGENT_EVAL_CONTAINER="$container" \
      uv run python run_matrix.py \
        --agent "$agent" \
        --defense "$defense" \
        --datasets "$dataset" \
        --model "$MODEL" \
        --mcp-port "$port" \
        --timeout "$TIMEOUT" \
        --outdir "$OUTDIR" \
        >> "$log" 2>&1 || echo "CELL_FAIL $agent $defense $dataset rc=$?" >> "$log"
      # CAITLYN AgentDojo rerun for the three agents whose AD cell used the
      # pre-tune daemon prompt.
      if [[ "$defense" == "caitlyn" && "$dataset" == "safeclawbench_subset" ]] \
         && [[ "$agent" == "pi" || "$agent" == "hermes" || "$agent" == "openclaw" ]]; then
        echo "CELL $agent caitlyn agentdojo_subset (v3 rerun)" >> "$log"
        AGENT_EVAL_CONTAINER="$container" \
        uv run python run_matrix.py \
          --agent "$agent" \
          --defense caitlyn \
          --datasets agentdojo_subset \
          --model "$MODEL" \
          --mcp-port "$port" \
          --timeout "$TIMEOUT" \
          --outdir "$OUTDIR" \
          >> "$log" 2>&1 || echo "CELL_FAIL $agent caitlyn agentdojo_subset rc=$?" >> "$log"
      fi
    done
  done
  attach_costs "$agent" "$container" >> "$log" 2>&1 || true
  echo "AGENT_DONE $agent $(date -Is)" >> "$log"
}

attach_costs() {
  local agent="$1"
  local container="$2"
  local paths=()
  for dataset in aspi_subset safeclawbench_subset; do
    paths+=("$OUTDIR/${agent}-caitlyn-${dataset}.json")
    paths+=("$OUTDIR/${agent}-llm_judge-${dataset}.json")
    paths+=("$OUTDIR/${agent}-llm_judge_fewshot-${dataset}.json")
    paths+=("$OUTDIR/${agent}-regex_guard-${dataset}.json")
    paths+=("$OUTDIR/${agent}-spotlighting-${dataset}.json")
    paths+=("$OUTDIR/${agent}-tool_filter-${dataset}.json")
    paths+=("$OUTDIR/${agent}-pi_detector-${dataset}.json")
    paths+=("$OUTDIR/${agent}-none-${dataset}.json")
  done
  if [[ "$agent" == "pi" || "$agent" == "hermes" || "$agent" == "openclaw" ]]; then
    paths+=("$OUTDIR/${agent}-caitlyn-agentdojo_subset.json")
  fi
  case "$agent" in
    opencode) AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_agent_cost.py "${paths[@]}" ;;
    pi)       AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_pi_cost.py "${paths[@]}" ;;
    hermes)   uv run python scripts/attach_hermes_cost.py "${paths[@]}" ;;
    openclaw) AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_openclaw_cost.py --since-epoch "$START_EPOCH" "${paths[@]}" ;;
    codex)    AGENT_EVAL_CONTAINER="$container" uv run python scripts/attach_codex_cost.py "${paths[@]}" ;;
  esac
}

PIDS=()
export OUTDIR MODEL TIMEOUT START_EPOCH
for agent in opencode pi hermes openclaw codex; do
  setsid bash -c "$(declare -f run_agent attach_costs); run_agent $agent ${CONTAINERS[$agent]} ${PORTS[$agent]}" \
    > "$OUTDIR/${agent}_prompt_channel_matrix_wrapper.log" 2>&1 &
  PIDS+=("$!")
done

FAILED=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    FAILED=1
  fi
done
echo "TABLE1_PROMPT_CHANNEL_MATRIX_DONE failed=$FAILED"
exit "$FAILED"
