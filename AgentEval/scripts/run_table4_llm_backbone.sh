#!/usr/bin/env bash
# Table 4: OpenCode x CAITLYN x SafeClawBench-S240, one backbone per row.
# Victim model and CAITLYN daemon co-vary. Semantic judge is pinned.
#
# Waits for the Table 1 e2e matrix to release the agent-eval container.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/AgentEval"
AGENT="$ROOT/caitlyn-agent"
OUTDIR="${OUTDIR:-$EVAL/results/eval/table4}"
LOG="$OUTDIR/table4.log"
PIDFILE="${PIDFILE:-/tmp/caitlyn-table4.pid}"
PORT="${PORT:-9072}"
MCP_PORT="${MCP_PORT:-9878}"
TIMEOUT="${TIMEOUT:-180}"
# KEYPOINT: measurement judge stays on the Table 1 SCB model.
JUDGE_MODEL="${JUDGE_MODEL:-deepseek/deepseek-chat}"
MODELS=(
  deepseek/deepseek-v4-flash-0731
  qwen/qwen3.8-max
  z-ai/glm-5.3
  moonshotai/kimi-k3
  minimax/minimax-m3
)

mkdir -p "$OUTDIR"

table1_busy() {
  pgrep -af "run_caitlyn_main_table|run_matrix.py|run_benchmark.py" \
    | grep -v "run_table4_llm_backbone\|fill_table4\|watch_caitlyn_table1\|pgrep" \
    >/dev/null
}

wait_for_table1() {
  if ! table1_busy; then
    echo "table1 container is free"
    return 0
  fi
  echo "waiting for Table 1 e2e to release agent-eval"
  while table1_busy; do
    sleep 60
  done
  echo "table1 finished, starting Table 4"
}

start_daemon() {
  local model="$1"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "stopping table4 daemon pid=$(cat "$PIDFILE")"
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  echo "starting table4 daemon on ${PORT} model=${model}"
  cd "$AGENT"
  CAITLYN_PID_FILE="$PIDFILE" \
  CAITLYN_DISABLE_EVOLUTION=1 \
  CAITLYN_MODEL="$model" \
  nohup npx tsx src/daemon-entry.ts --port "$PORT" >>"$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then
      echo "table4 daemon ready (${model})"
      return 0
    fi
    sleep 0.5
  done
  echo "table4 daemon failed to start; last log:"
  tail -n 40 "$LOG" || true
  exit 1
}

run_one() {
  local model="$1"
  local tag="${model//\//__}"
  local out="$OUTDIR/opencode-caitlyn-safeclawbench-${tag}.json"
  if [[ -f "$out" ]]; then
    echo "skip ${model} (result exists)"
    return 0
  fi
  start_daemon "$model"
  local start_ms
  start_ms="$(python3 -c 'import time; print(int(time.time()*1000))')"
  echo "===== TABLE4 ${model} ====="
  cd "$EVAL"
  PYTHONPATH=src PYTHONUNBUFFERED=1 uv run python run_benchmark.py \
    --agent opencode \
    --defense caitlyn \
    --dataset safeclawbench_subset \
    --max-attacks 240 \
    --model "$model" \
    --judge-model "$JUDGE_MODEL" \
    --timeout "$TIMEOUT" \
    --mcp-port "$MCP_PORT" \
    --caitlyn-port "$PORT" \
    --score-utility \
    --output "$out"
  uv run python scripts/attach_agent_cost.py --start-ms "$start_ms" "$out"
  uv run python scripts/analyze_row.py "$out.withcost.json"
  uv run python scripts/fill_table4.py --latex || true
  echo "===== DONE ${model} ====="
}

wait_for_table1
for model in "${MODELS[@]}"; do
  run_one "$model"
done
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
fi
echo "TABLE4_LLM_BACKBONE_DONE"
