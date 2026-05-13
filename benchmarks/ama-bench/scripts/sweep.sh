#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(dirname "$SCRIPT_DIR")"
AMA_BENCH="$(cd "$BENCH_DIR/../../.." && pwd)/AMA-Bench"
BRIDGE_PORT="${BRIDGE_PORT:-3456}"
SWEEP_CONFIG="${SWEEP_CONFIG:-$BENCH_DIR/configs/sweep.json}"
DEFAULT_CONFIG="$BENCH_DIR/configs/default.json"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="$BENCH_DIR/results/sweep_$TIMESTAMP"

LLM_CONFIG="${LLM_CONFIG:-$AMA_BENCH/configs/gpt-4o.yaml}"
JUDGE_CONFIG="${JUDGE_CONFIG:-$AMA_BENCH/configs/llm_judge.yaml}"

echo "=== Contexto Parameter Sweep ==="
echo "Sweep config: $SWEEP_CONFIG"
echo "Results dir: $RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

# Save original default.json to restore later
cp "$DEFAULT_CONFIG" "$RESULTS_DIR/_default.json.bak"

# Read param arrays from sweep config
read -ra SIM_THRESHOLDS <<< "$(jq -r '.similarityThreshold | join(" ")' "$SWEEP_CONFIG")"
read -ra MAX_DEPTHS <<< "$(jq -r '.maxDepth | join(" ")' "$SWEEP_CONFIG")"
read -ra BEAM_WIDTHS <<< "$(jq -r '.beamWidth | join(" ")' "$SWEEP_CONFIG")"
read -ra MIN_SCORES <<< "$(jq -r '.minScore | join(" ")' "$SWEEP_CONFIG")"
read -ra MAX_RESULTS <<< "$(jq -r '.maxResults | join(" ")' "$SWEEP_CONFIG")"

TOTAL=$(( ${#SIM_THRESHOLDS[@]} * ${#MAX_DEPTHS[@]} * ${#BEAM_WIDTHS[@]} * ${#MIN_SCORES[@]} * ${#MAX_RESULTS[@]} ))
echo "Total configs: $TOTAL"

# Ensure cleanup on exit
BRIDGE_PID=""
cleanup() {
  echo ""
  if [ -n "$BRIDGE_PID" ]; then
    echo "Shutting down bridge server..."
    kill $BRIDGE_PID 2>/dev/null || true
    wait $BRIDGE_PID 2>/dev/null || true
  fi
  # Restore original config
  cp "$RESULTS_DIR/_default.json.bak" "$DEFAULT_CONFIG"
}
trap cleanup EXIT

# Run sweep
echo "[1/2] Running parameter sweep..."
COUNT=0
SUMMARY="$RESULTS_DIR/sweep_summary.csv"
echo "similarityThreshold,maxDepth,beamWidth,minScore,maxResults,accuracy" > "$SUMMARY"

for st in "${SIM_THRESHOLDS[@]}"; do
for md in "${MAX_DEPTHS[@]}"; do
for bw in "${BEAM_WIDTHS[@]}"; do
for ms in "${MIN_SCORES[@]}"; do
for mr in "${MAX_RESULTS[@]}"; do
  COUNT=$((COUNT + 1))
  echo ""
  echo "[$COUNT/$TOTAL] st=$st md=$md bw=$bw ms=$ms mr=$mr"

  # Write config for this combo
  cat > "$DEFAULT_CONFIG" <<EOF
{
  "provider": "openrouter",
  "embedModel": "openai/text-embedding-3-small",
  "mindmap": {
    "similarityThreshold": $st,
    "maxDepth": $md,
    "maxChildren": 10,
    "rebuildInterval": 50
  },
  "search": {
    "maxResults": $mr,
    "maxTokens": 4000,
    "beamWidth": $bw,
    "minScore": $ms
  }
}
EOF

  # Restart bridge with new config
  if [ -n "$BRIDGE_PID" ]; then
    kill $BRIDGE_PID 2>/dev/null || true
    wait $BRIDGE_PID 2>/dev/null || true
  fi
  cd "$BENCH_DIR"
  BRIDGE_PORT=$BRIDGE_PORT bun src/server.ts &
  BRIDGE_PID=$!

  for i in $(seq 1 30); do
    if curl -s "http://localhost:$BRIDGE_PORT/health" > /dev/null 2>&1; then
      break
    fi
    [ "$i" -eq 30 ] && echo "ERROR: Bridge timeout" && exit 1
    sleep 1
  done

  # Run benchmark
  cd "$AMA_BENCH"
  OUTPUT=$(python src/run.py \
    --llm-server api \
    --llm-config "$LLM_CONFIG" \
    --subset openend \
    --method contexto \
    --method-config configs/contexto.yaml \
    --test-dir dataset/test \
    --judge-config "$JUDGE_CONFIG" \
    --evaluate True 2>&1) || true

  # Parse accuracy from output
  ACCURACY=$(echo "$OUTPUT" | grep -i "overall" | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo "0.0")
  echo "  -> Accuracy: $ACCURACY"
  echo "$st,$md,$bw,$ms,$mr,$ACCURACY" >> "$SUMMARY"

done
done
done
done
done

# Print ranked results
echo ""
echo "============================================================"
echo "SWEEP RESULTS (ranked by accuracy)"
echo "============================================================"
sort -t, -k6 -rn "$SUMMARY" | head -11

echo ""
echo "[2/2] Sweep complete. Results: $SUMMARY"
