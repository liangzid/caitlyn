#!/usr/bin/env bash
# Rerun the ASPI-S column with the full-prompt protocol (base task +
# clarification reply scanned together, consistent with SafeClawBench and
# the detection-only sweep). All 8 defenses x 5 agents, in parallel across
# 5 containers, then attach per-agent costs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="$ROOT/AgentEval"
cd "$EVAL"
export PYTHONPATH=src
export PYTHONUNBUFFERED=1

MODEL="${MODEL:-deepseek/deepseek-chat}"
TIMEOUT="${TIMEOUT:-180}"
OUTDIR="${OUTDIR:-results/eval}"
export OUTDIR MODEL TIMEOUT

declare -A CONTAINERS=( [opencode]=agent-eval-7 [pi]=agent-eval-2 [hermes]=agent-eval-3 [openclaw]=agent-eval-4 [codex]=agent-eval-5 )
declare -A PORTS=( [opencode]=9885 [pi]=9886 [hermes]=9887 [openclaw]=9888 [codex]=9889 )

for agent in opencode pi hermes openclaw codex; do
  for defense in none regex_guard llm_judge llm_judge_fewshot spotlighting tool_filter pi_detector caitlyn; do
    f="$OUTDIR/${agent}-${defense}-aspi_subset.json"
    if [[ -f "$f" ]] && [[ ! -f "$OUTDIR/backup_aspi_replyonly_20260823/$(basename "$f")" ]]; then
      mkdir -p "$OUTDIR/backup_aspi_replyonly_20260823"
      cp -p "$f" "$OUTDIR/backup_aspi_replyonly_20260823/"
    fi
  done
done

PIDS=()
for agent in opencode pi hermes openclaw codex; do
  setsid bash scripts/run_aspi_one_agent.sh "$agent" "${CONTAINERS[$agent]}" "${PORTS[$agent]}" \
    > "$OUTDIR/${agent}_aspi_fullprompt_wrapper.log" 2>&1 &
  PIDS+=("$!")
done
FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=1
done
echo "ASPI_FULLPROMPT_MATRIX_DONE failed=$FAILED"
exit "$FAILED"
