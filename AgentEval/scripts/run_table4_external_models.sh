#!/usr/bin/env bash
# Table 3 (LLM API comparison): OpenCode x CAITLYN x SafeClawBench-S240
# for the restricted external backbones served by the AICodeMirror relay.
#
# Victim model (opencode) and CAITLYN daemon co-vary. The semantic judge
# stays pinned to deepseek/deepseek-chat on OpenRouter so ASR/Utility are
# comparable across backbones. The relay key is read at runtime from
# ~/ai-code-mirror-apikey.txt and never written into result files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/AgentEval"
AGENT="$ROOT/caitlyn-agent"
OUTDIR="${OUTDIR:-$EVAL/results/eval/table4}"
LOG="$OUTDIR/table4_external.log"
PIDFILE="${PIDFILE:-/tmp/caitlyn-table4-external.pid}"
PORT="${PORT:-9072}"
MCP_PORT="${MCP_PORT:-9878}"
TIMEOUT="${TIMEOUT:-180}"
# KEYPOINT: measurement judge stays on the Table 1 SCB model.
JUDGE_MODEL="${JUDGE_MODEL:-deepseek/deepseek-chat}"
RELAY_KEY_FILE="${RELAY_KEY_FILE:-$HOME/ai-code-mirror-apikey.txt}"

# opencode provider-qualified model -> daemon provider/model
MODELS=(
  aicodemirror-claude/claude-opus-4-6
  aicodemirror-claude/claude-fable-5
  aicodemirror/gpt-5.6-sol
  aicodemirror-gemini/gemini-3.5-flash
  aicodemirror-gemini/gemini-3.7-flash
)

daemon_provider_for() {
  case "$1" in
    aicodemirror-claude/*) echo anthropic ;;
    aicodemirror/*) echo openai ;;
    aicodemirror-gemini/*) echo google ;;
    *) echo "unknown provider prefix in $1" >&2; exit 1 ;;
  esac
}

daemon_model_for() {
  echo "${1##*/}"
}

mkdir -p "$OUTDIR"

if [[ ! -f "$RELAY_KEY_FILE" ]]; then
  echo "relay key file missing: $RELAY_KEY_FILE" >&2
  exit 1
fi

table1_busy() {
  pgrep -af "run_caitlyn_main_table|run_matrix.py|run_benchmark.py" \
    | grep -v "run_table4_external_models\|fill_table4\|watch_caitlyn_table1\|pgrep" \
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
  echo "table1 finished, starting external Table 3 rows"
}

start_daemon() {
  local model="$1"
  local daemon_provider daemon_model
  daemon_provider="$(daemon_provider_for "$model")"
  daemon_model="$(daemon_model_for "$model")"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "stopping external table4 daemon pid=$(cat "$PIDFILE")"
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  echo "starting external table4 daemon on ${PORT} provider=${daemon_provider} model=${daemon_model}"
  cd "$AGENT"
  CAITLYN_PID_FILE="$PIDFILE" \
  CAITLYN_DISABLE_EVOLUTION=1 \
  CAITLYN_PROVIDER="$daemon_provider" \
  CAITLYN_MODEL="$daemon_model" \
  ANTHROPIC_API_KEY="$(cat "$RELAY_KEY_FILE")" \
  OPENAI_API_KEY="$(cat "$RELAY_KEY_FILE")" \
  GEMINI_API_KEY="$(cat "$RELAY_KEY_FILE")" \
  GOOGLE_API_KEY="$(cat "$RELAY_KEY_FILE")" \
  nohup npx tsx src/daemon-entry.ts --port "$PORT" >>"$LOG" 2>&1 &
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then
      echo "external table4 daemon ready (${daemon_model})"
      return 0
    fi
    sleep 0.5
  done
  echo "external table4 daemon failed to start; last log:"
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
  echo "===== TABLE4-EXTERNAL ${model} ====="
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
echo "TABLE4_EXTERNAL_MODELS_DONE"
