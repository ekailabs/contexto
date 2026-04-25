#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(dirname "$SCRIPT_DIR")"
AMA_BENCH="$(cd "$BENCH_DIR/../../.." && pwd)/AMA-Bench"
BRIDGE_PORT="${BRIDGE_PORT:-3456}"

# Load .env if present (optional — judge/LLM api keys live in AMA-Bench configs)
if [ -f "$BENCH_DIR/.env" ]; then
  set -a
  source "$BENCH_DIR/.env"
  set +a
fi

# MODE picks coherent defaults across the bridge config + AMA-Bench LLM/judge.
#   local   → Ollama embed + VLLM (Qwen3-32B) for episodic + answer-gen + judge. No API keys, requires GPUs.
#   openai  → OpenAI for everything (embed + episodic + answer-gen + judge). No GPUs, costs $$.
#   hybrid  → Ollama embed (no rate limits) + OpenAI for episodic + answer-gen + judge. No GPUs.
# Any individual env var below can override the MODE preset.
MODE="${MODE:-local}"

case "$MODE" in
  local)
    DEFAULT_BENCH_CONFIG="$BENCH_DIR/configs/local.json"
    DEFAULT_LLM_SERVER="vllm"
    DEFAULT_JUDGE_SERVER="vllm"
    DEFAULT_LLM_CONFIG="$AMA_BENCH/configs/qwen3-32B.yaml"
    DEFAULT_JUDGE_CONFIG="$AMA_BENCH/configs/llm_judge.yaml"
    ;;
  openai)
    DEFAULT_BENCH_CONFIG="$BENCH_DIR/configs/openai.json"
    DEFAULT_LLM_SERVER="api"
    DEFAULT_JUDGE_SERVER="api"
    DEFAULT_LLM_CONFIG="$AMA_BENCH/configs/gpt-5.2.yaml"
    DEFAULT_JUDGE_CONFIG="$AMA_BENCH/configs/llm_judge_api.yaml"
    ;;
  hybrid)
    DEFAULT_BENCH_CONFIG="$BENCH_DIR/configs/hybrid.json"
    DEFAULT_LLM_SERVER="api"
    DEFAULT_JUDGE_SERVER="api"
    DEFAULT_LLM_CONFIG="$AMA_BENCH/configs/gpt-5.2.yaml"
    DEFAULT_JUDGE_CONFIG="$AMA_BENCH/configs/llm_judge_api.yaml"
    ;;
  *)
    echo "ERROR: unknown MODE='$MODE'. Valid: local | openai | hybrid"
    exit 1
    ;;
esac

# Per-var overrides (caller can mix and match)
BENCH_CONFIG="${BENCH_CONFIG:-$DEFAULT_BENCH_CONFIG}"
LLM_SERVER="${LLM_SERVER:-$DEFAULT_LLM_SERVER}"
JUDGE_SERVER="${JUDGE_SERVER:-$DEFAULT_JUDGE_SERVER}"
LLM_CONFIG="${LLM_CONFIG:-$DEFAULT_LLM_CONFIG}"
JUDGE_CONFIG="${JUDGE_CONFIG:-$DEFAULT_JUDGE_CONFIG}"
SUBSET="${SUBSET:-openend}"
METHOD_CONFIG="${METHOD_CONFIG:-$AMA_BENCH/configs/contexto.yaml}"
EXTRA_ARGS="${*:-}"

echo "MODE=$MODE  bridge=$BENCH_CONFIG  llm=$LLM_SERVER:$LLM_CONFIG  judge=$JUDGE_SERVER:$JUDGE_CONFIG"

echo "=== Running AMA-Bench with contexto method ==="
echo "AMA-Bench dir: $AMA_BENCH"

# Pre-flight: detect configured embed.type from chosen bench config
EMBED_TYPE="$(python3 -c "import json; print(json.load(open('$BENCH_CONFIG')).get('embed',{}).get('type','ollama'))" 2>/dev/null || echo "ollama")"

if [ "$EMBED_TYPE" = "ollama" ]; then
  OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
  EMBED_MODEL_HINT="qwen3-embedding"
  if ! curl -sf "$OLLAMA_URL/api/tags" >/dev/null; then
    echo "ERROR: Ollama not reachable at $OLLAMA_URL"
    echo "  Install: brew install ollama"
    echo "  Start:   ollama serve &"
    exit 1
  fi
  if ! curl -sf "$OLLAMA_URL/api/tags" | grep -q "$EMBED_MODEL_HINT"; then
    echo "ERROR: embedding model not found in Ollama"
    echo "  Pull: ollama pull qwen3-embedding:0.6b"
    exit 1
  fi
  echo "Ollama OK ($OLLAMA_URL) — $EMBED_MODEL_HINT present"
else
  # Cloud provider — bridge will read apiKey from config or API_KEY env var
  if [ -z "${API_KEY:-}" ]; then
    # not fatal — embed.apiKey in configs/default.json may be set directly
    echo "NOTE: embed.type=$EMBED_TYPE — bridge will use embed.apiKey from configs/default.json or API_KEY env var"
  else
    echo "Embed: $EMBED_TYPE (using API_KEY from environment)"
  fi
fi

# Episodic summary layer: only require an API key when the baseUrl is NOT localhost
EPISODIC_ENABLED="$(python3 -c "import json; print(str(json.load(open('$BENCH_CONFIG')).get('episodic',{}).get('enabled', True)).lower())" 2>/dev/null || echo "true")"
EPISODIC_BASEURL="$(python3 -c "import json; print(json.load(open('$BENCH_CONFIG')).get('episodic',{}).get('baseUrl',''))" 2>/dev/null || echo "")"
if [ "$EPISODIC_ENABLED" = "true" ]; then
  case "$EPISODIC_BASEURL" in
    *localhost*|*127.0.0.1*|*0.0.0.0*) EPISODIC_LOCAL=1 ;;
    *) EPISODIC_LOCAL=0 ;;
  esac
  if [ "$EPISODIC_LOCAL" = "0" ] && [ -z "${API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "ERROR: episodic baseUrl=$EPISODIC_BASEURL needs API_KEY or OPENAI_API_KEY"
    echo "  Set one in .env, switch to MODE=local, or disable the layer (episodic.enabled=false)."
    exit 1
  fi
  echo "Episodic: enabled (baseUrl=$EPISODIC_BASEURL)"
else
  echo "Episodic: disabled (raw turn content will be embedded directly)"
fi

# OpenAI key required when LLM_SERVER or JUDGE_SERVER hits the API
if [ "$LLM_SERVER" = "api" ] || [ "$JUDGE_SERVER" = "api" ]; then
  if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${API_KEY:-}" ]; then
    echo "ERROR: LLM_SERVER/JUDGE_SERVER=api requires OPENAI_API_KEY in .env"
    exit 1
  fi
fi

# Start bridge server in background
echo "[1/3] Starting contexto bridge server on port $BRIDGE_PORT..."
cd "$BENCH_DIR"
BRIDGE_PORT=$BRIDGE_PORT BENCH_CONFIG="$BENCH_CONFIG" API_KEY="${API_KEY:-}" OPENAI_API_KEY="${OPENAI_API_KEY:-}" bun src/server.ts &
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

# If using VLLM for answer generation, launch it via AMA-Bench's helper
if [ "$LLM_SERVER" = "vllm" ]; then
  echo "[1b/3] Launching VLLM answer-gen server (config: $LLM_CONFIG)..."
  cd "$AMA_BENCH"
  bash scripts/launch_vllm_32B.sh "$LLM_CONFIG"
fi

# Run AMA-Bench
echo "[2/3] Running AMA-Bench evaluation..."
cd "$AMA_BENCH"
python src/run.py \
  --llm-server "$LLM_SERVER" \
  --llm-config "$LLM_CONFIG" \
  --subset "$SUBSET" \
  --method contexto \
  --method-config "$METHOD_CONFIG" \
  --test-dir dataset/test \
  --judge-config "$JUDGE_CONFIG" \
  --judge-server "$JUDGE_SERVER" \
  --evaluate True \
  $EXTRA_ARGS

echo "[3/3] Benchmark complete. Results saved in $AMA_BENCH/results/"
