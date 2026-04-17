#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(dirname "$SCRIPT_DIR")"
AMA_BENCH="$(cd "$BENCH_DIR/../../.." && pwd)/AMA-Bench"
BRIDGE_PORT="${BRIDGE_PORT:-3456}"

# Load .env if present
if [ -f "$BENCH_DIR/.env" ]; then
  set -a
  source "$BENCH_DIR/.env"
  set +a
fi

# Validate required vars
if [ -z "${API_KEY:-}" ]; then
  echo "ERROR: API_KEY not set. Export it or add to .env"
  exit 1
fi

# Parse arguments (pass through to run.py)
LLM_CONFIG="${LLM_CONFIG:-$AMA_BENCH/configs/openrouter.yaml}"
SUBSET="${SUBSET:-openend}"
JUDGE_CONFIG="${JUDGE_CONFIG:-$AMA_BENCH/configs/llm_judge_openrouter.yaml}"
METHOD_CONFIG="${METHOD_CONFIG:-$AMA_BENCH/configs/contexto.yaml}"
EXTRA_ARGS="${@}"

echo "=== Running AMA-Bench with contexto method ==="
echo "AMA-Bench dir: $AMA_BENCH"

# Start bridge server in background
echo "[1/3] Starting contexto bridge server on port $BRIDGE_PORT..."
cd "$BENCH_DIR"
API_KEY=$API_KEY BRIDGE_PORT=$BRIDGE_PORT bun src/server.ts &
BRIDGE_PID=$!

# Ensure cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down bridge server (PID: $BRIDGE_PID)..."
  kill $BRIDGE_PID 2>/dev/null || true
  wait $BRIDGE_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for bridge to be ready
echo "Waiting for bridge server..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$BRIDGE_PORT/health" > /dev/null 2>&1; then
    echo "Bridge server ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Bridge server failed to start within 30 seconds."
    exit 1
  fi
  sleep 1
done

# Run AMA-Bench
echo "[2/3] Running AMA-Bench evaluation..."
cd "$AMA_BENCH"
python src/run.py \
  --llm-server api \
  --llm-config "$LLM_CONFIG" \
  --subset "$SUBSET" \
  --method contexto \
  --method-config "$METHOD_CONFIG" \
  --test-dir dataset/test \
  --judge-config "$JUDGE_CONFIG" \
  --evaluate True \
  $EXTRA_ARGS

echo "[3/3] Benchmark complete. Results saved in $AMA_BENCH/results/"
