#!/usr/bin/env bash
# Resume the main-table CAITLYN matrix after the 2026-08-20 host fault.
# Keep opencode AgentDojo + ASPI (daemon was alive). Rerun opencode
# SafeClawBench, then the remaining four agents.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
export PYTHONUNBUFFERED=1
MODEL="${MODEL:-deepseek/deepseek-chat}"
OUTDIR="${OUTDIR:-results/eval}"
MCP_PORT="${MCP_PORT:-9877}"
TIMEOUT="${TIMEOUT:-180}"

echo "===== RESUME opencode caitlyn safeclawbench_subset ====="
uv run python run_matrix.py \
  --agent opencode \
  --defense caitlyn \
  --datasets safeclawbench_subset \
  --model "${MODEL}" \
  --mcp-port "${MCP_PORT}" \
  --timeout "${TIMEOUT}" \
  --outdir "${OUTDIR}"
echo "===== DONE opencode ====="

for agent in pi hermes openclaw codex; do
  echo "===== MATRIX ${agent} caitlyn ${MODEL} ====="
  uv run python run_matrix.py \
    --agent "${agent}" \
    --defense caitlyn \
    --model "${MODEL}" \
    --mcp-port "${MCP_PORT}" \
    --timeout "${TIMEOUT}" \
    --outdir "${OUTDIR}"
  echo "===== DONE ${agent} ====="
done
echo "CAITLYN_MAIN_TABLE_DONE"
