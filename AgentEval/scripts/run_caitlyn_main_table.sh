#!/usr/bin/env bash
# Run the main-table CAITLYN cells (5 agents x 3 datasets).
# Same protocol as the filled baseline rows: deepseek/deepseek-chat,
# AgentDojo-S250 + 97 benign, ASPI 31 source rows, SafeClawBench-S240.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
export PYTHONUNBUFFERED=1
MODEL="${MODEL:-deepseek/deepseek-chat}"
OUTDIR="${OUTDIR:-results/eval}"
MCP_PORT="${MCP_PORT:-9877}"
TIMEOUT="${TIMEOUT:-180}"
AGENTS=(opencode pi hermes openclaw codex)

for agent in "${AGENTS[@]}"; do
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
