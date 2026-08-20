#!/usr/bin/env bash
# System I ablation for paper section 4.4.
# Variants: t0-only, none (no Tier 0), ensemble, merged,
# merged-detectors, full (T0 + merged-pair).
# Uses a second daemon on 9071 so the Table 1 e2e daemon on 9070 is untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/AgentEval"
AGENT="$ROOT/caitlyn-agent"
OUTROOT="${OUTROOT:-$EVAL/results/ablation_system_i_20260820}"
PORT="${PORT:-9071}"
MODEL="${MODEL:-deepseek/deepseek-v4-pro}"
PIDFILE="${PIDFILE:-/tmp/caitlyn-ablation.pid}"
LOG="$OUTROOT/daemon.log"

mkdir -p "$OUTROOT"

start_daemon() {
  if curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then
    echo "ablation daemon already healthy on ${PORT}"
    return 0
  fi
  echo "starting ablation daemon on ${PORT} (model=${MODEL})"
  cd "$AGENT"
  CAITLYN_PID_FILE="$PIDFILE" \
  CAITLYN_DISABLE_EVOLUTION=1 \
  CAITLYN_MODEL="$MODEL" \
  nohup npx tsx src/daemon-entry.ts --port "$PORT" >>"$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then
      echo "ablation daemon ready"
      return 0
    fi
    sleep 0.5
  done
  echo "ablation daemon failed to start; last log:"
  tail -n 40 "$LOG" || true
  exit 1
}

run_variant() {
  local label="$1"
  local mode="$2"
  local workers="$3"
  local out="$OUTROOT/$label"
  if [[ -f "$out/summary.json" ]]; then
    echo "skip $label (summary.json already exists)"
    return 0
  fi
  echo "===== ABLATION ${label} mode=${mode} workers=${workers} ====="
  mkdir -p "$out"
  cd "$EVAL"
  PYTHONPATH=src PYTHONUNBUFFERED=1 uv run python run_detection_experiment.py \
    --datasets agentdojo aspi safeclawbench agentdefense \
    --detectors caitlyn \
    --caitlyn-mode "$mode" \
    --caitlyn-port "$PORT" \
    --caitlyn-daemon-model "$MODEL" \
    --workers "$workers" \
    --output-dir "$out"
  echo "===== DONE ${label} ====="
}

start_daemon

# Cheap first: no LLM.
run_variant t0-only t0-only 8
# T1 variants share workers=2 with the paper detection sweep.
run_variant none none 2
run_variant ensemble ensemble 2
run_variant merged merged 2
run_variant merged-detectors merged-detectors 2
run_variant full merged-pair 2

PYTHONPATH="$EVAL/src" uv run python "$EVAL/scripts/summarize_system_i_ablation.py" \
  --root "$OUTROOT"
echo "SYSTEM_I_ABLATION_DONE"
