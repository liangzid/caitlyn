#!/usr/bin/env bash
# Rerun the detection-only sweep and System I ablation with the tuned (v3)
# merged-pair prompt, merge the new CAITLYN records with the unchanged
# baseline records, and regenerate the paper figures.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/AgentEval"
AGENT="$ROOT/caitlyn-agent"
cd "$EVAL"
export PYTHONPATH=src
export PYTHONUNBUFFERED=1

MODEL="${MODEL:-deepseek/deepseek-chat}"
PORT="${PORT:-9071}"
SWEEP_OUT="${SWEEP_OUT:-results/detection_paper_v3_20260821}"
MERGED_OUT="${MERGED_OUT:-results/detection_paper_v3_merged_20260821}"
BASE_RECORDS="${BASE_RECORDS:-results/detection_paper_clean_20260820/records.jsonl}"

# Tuned daemon on a dedicated port so the e2e daemon on 9070 is untouched.
if ! curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then
  cd "$AGENT"
  CAITLYN_PID_FILE="/tmp/caitlyn-v3-${PORT}.pid" \
  CAITLYN_DISABLE_EVOLUTION=1 \
  CAITLYN_MODEL="$MODEL" \
  setsid bash -c "nohup npx tsx src/daemon-entry.ts --port $PORT \
    > /tmp/caitlyn-v3-${PORT}.log 2>&1 & echo \$! > /tmp/caitlyn-v3-${PORT}.pid"
  cd "$EVAL"
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
curl -sf "http://127.0.0.1:${PORT}/v1/health" >/dev/null || exit 1

echo "===== V3 DETECTION SWEEP ====="
uv run python run_detection_experiment.py \
  --datasets agentdojo aspi safeclawbench agentdefense \
  --detectors caitlyn \
  --caitlyn-mode merged-pair \
  --caitlyn-port "$PORT" \
  --caitlyn-daemon-model "$MODEL" \
  --workers 4 \
  --output-dir "$SWEEP_OUT"

echo "===== MERGE WITH BASELINES ====="
uv run python scripts/merge_detection_runs.py \
  --base "$BASE_RECORDS" \
  --override "$SWEEP_OUT/records.jsonl" \
  --output "$MERGED_OUT"

echo "===== PLOT FIGURES ====="
uv run python scripts/plot_detection_curves.py \
  --records "$MERGED_OUT/records.jsonl" \
  --outdir "$MERGED_OUT/figures"

echo "===== SYSTEM I ABLATION (V3) ====="
OUTROOT="$PWD/results/ablation_system_i_v3_20260821" PORT="$PORT" MODEL="$MODEL" \
  bash scripts/run_system_i_ablation.sh

echo "V3_DETECTION_PIPELINE_DONE"
