#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(dirname "$SCRIPT_DIR")"
AMA_BENCH="$(cd "$BENCH_DIR/../../.." && pwd)/AMA-Bench"

echo "=== AMA-Bench Setup for Contexto ==="
echo "AMA-Bench: $AMA_BENCH"

# 1. Clone AMA-Bench (if not already present)
if [ ! -d "$AMA_BENCH" ]; then
  echo "[1/4] Cloning AMA-Bench..."
  git clone https://github.com/ekailabs/AMA-Bench.git "$AMA_BENCH"
else
  echo "[1/4] AMA-Bench already exists, skipping clone."
fi

# 2. Install Python dependencies
echo "[2/4] Installing Python dependencies..."
cd $AMA_BENCH
pip install -r requirements.txt
cd ..

# 3. Download dataset
if [ ! -d "$AMA_BENCH/dataset" ]; then
  echo "[3/4] Downloading AMA-Bench dataset..."
  huggingface-cli download AMA-bench/AMA-bench --repo-type dataset --local-dir "$AMA_BENCH/dataset"
else
  echo "[3/4] Dataset already downloaded."
fi

# 4. Install bridge dependencies
echo "[4/4] Installing bridge dependencies..."
cd "$BENCH_DIR" && pnpm install

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit configs/default.json (provider, embedModel, mindmap params)"
echo "  2. Export API_KEY=your-api-key"
echo "  3. Run: bash scripts/run.sh"
