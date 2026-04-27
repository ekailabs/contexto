# AMA-Bench Benchmark for @ekai/mindmap

Benchmarks the `@ekai/mindmap` package against [AMA-Bench](https://github.com/ekailabs/AMA-Bench), an evaluation framework for Associative Memory Ability in AI agents.

## Architecture

```
AMA-Bench (Python)                    Bridge Server (TypeScript)
┌──────────────────────┐              ┌───────────────────────────┐
│ run.py               │              │ server.ts                 │
│   └─ ContextoMethod  │   HTTP       │   └─ @ekai/mindmap        │
│       │              │──────────────▶       ├─ mindmap.add()    │
│       │ construct    │ /construct   │       │  (embed+cluster)  │
│       │ retrieve     │ /retrieve    │       └─ mindmap.search() │
│       ▼              │              │          (beam search)    │
│ LLM generates answer │              │                           │
│ Judge scores answer  │              │ reads configs/default.json│
└──────────────────────┘              └───────────────────────────┘

ekailabs/AMA-Bench repo                ekailabs/contexto repo
  src/method/contexto_method.py          benchmarks/ama-bench/src/server.ts
  configs/contexto.yaml                  benchmarks/ama-bench/configs/default.json
```

Two repos:
- **[ekailabs/AMA-Bench](https://github.com/ekailabs/AMA-Bench)** — Python benchmark framework + `contexto` method (thin HTTP client)
- **[ekailabs/contexto](https://github.com/ekailabs/contexto)** — Bridge server wrapping `@ekai/mindmap` + all config

## Prerequisites

Always required:
- [Bun](https://bun.sh) >= 1.0
- Python >= 3.9
- pnpm
- `huggingface-cli` (`pip install huggingface_hub`)

Mode-specific (see [Modes](#3-pick-a-mode) below):
- **`MODE=local`** — Linux box with 4+ GPUs (≈80GB VRAM total) for VLLM, plus [Ollama](https://ollama.com) for embeddings. No API keys needed.
- **`MODE=openai`** — `OPENAI_API_KEY` only. No GPUs, no Ollama.
- **`MODE=hybrid`** — Ollama for embeddings + `OPENAI_API_KEY` for LLM/judge/summarizer. Mac-friendly, no GPUs.
- **`MODE=bedrock`** — Ollama for embeddings + `BEDROCK_API_KEY` for everything else (Qwen3-32B for answer-gen + judge at 16k ctx, Qwen3-VL-235B-A22B (`/no_think`) for the summarizer at ~256k ctx — instruct-tuned for clean schema adherence). No GPUs, single key.

## Running Locally

### 1. Clone both repos

```bash
git clone https://github.com/ekailabs/contexto.git
git clone https://github.com/ekailabs/AMA-Bench.git
```

They should be siblings:

```
parent/
├── contexto/
└── AMA-Bench/
```

### 2. Install dependencies

```bash
# Install contexto workspace (includes the bridge)
cd contexto
pnpm install

# Install AMA-Bench Python deps
cd ../AMA-Bench
pip install -r requirements.txt

# Download the dataset
huggingface-cli download AMA-bench/AMA-bench --repo-type dataset --local-dir dataset
```

Or run the setup script which does all of the above (plus pulls the Ollama embedding model):

```bash
cd contexto/benchmarks/ama-bench
bash scripts/setup.sh
```

### 3. Pick a mode

`scripts/run.sh` exposes a single `MODE` switch that wires the bridge config + AMA-Bench LLM/judge consistently. Each mode maps to one preset in `configs/`.

| `MODE` | Embed | Episodic summarizer | Answer-gen + Judge | Needs |
|---|---|---|---|---|
| `bedrock` (default) | Ollama `qwen3-embedding:0.6b` | Bedrock Qwen3-VL-235B-A22B (`/no_think`) (~256k ctx) | Bedrock `qwen.qwen3-32b-v1:0` (16k ctx) | Ollama + `BEDROCK_API_KEY` |
| `local` | Ollama `qwen3-embedding:0.6b` | VLLM `Qwen/Qwen3-32B` | VLLM `Qwen/Qwen3-32B` | 4+ GPU box, Ollama, VLLM |
| `openai` | OpenAI `text-embedding-3-small` | OpenAI `gpt-4.1-mini` | OpenAI (`gpt-5.2` / `gpt-5.4` judge) | `OPENAI_API_KEY` |
| `hybrid` | Ollama `qwen3-embedding:0.6b` | OpenAI `gpt-4.1-mini` | OpenAI | Ollama + `OPENAI_API_KEY` |

The preset files are `configs/{local,openai,hybrid,bedrock}.json`. Edit them to tune `mindmap.*` / `search.*` or swap models — the bridge picks them up via the `BENCH_CONFIG` env var that `run.sh` sets.

### 3a. (Ollama-using modes) install + start Ollama

Skip if `MODE=openai`.

```bash
brew install ollama
ollama serve &                          # keep running in the background
ollama pull qwen3-embedding:4b          # ~2.5GB, one-time
```

Ollama serves embeddings on `http://localhost:11434` with zero rate limits.

> Note: `@ekai/mindmap`'s package default is still `text-embedding-3-small`. The Ollama embedding is a **benchmark-only override** baked into the preset.

### 3b. (`MODE=local` only) prep VLLM

Skip for `openai` / `hybrid`.

- Linux box with 4+ GPUs (≈80GB VRAM total — Qwen3-32B at `tensor_parallel_size=4`)
- `pip install vllm`
- Edit GPU IDs in `AMA-Bench/configs/qwen3-32B.yaml` (`vllm_launch.gpus`)

`run.sh` auto-invokes `AMA-Bench/scripts/launch_vllm_32B.sh` (idempotent — skips if already up on the configured port). Answer-gen, judge, and the episodic summarizer all share the one VLLM endpoint.

If you don't have GPUs locally, common alternatives: Lambda Labs, RunPod, Modal, Replicate, AWS EC2 (g6e.12xlarge), Bedrock (Qwen3-32B dense). Point `episodic.baseUrl` and the AMA-Bench yaml at the remote endpoint.

### 4. (Cloud-using modes) set your API key

Skip if `MODE=local`.

`.env`:
```
# MODE=openai / hybrid
OPENAI_API_KEY=sk-...

# MODE=bedrock (single key — summarizer uses Bedrock Nova 2 Lite 1M ctx,
# answer-gen + judge use Bedrock Qwen3-32B; prefer long-term keys)
BEDROCK_API_KEY=bedrock-api-key-...
```

`MODE=bedrock`: `run.sh` aliases `BEDROCK_API_KEY` → both `API_KEY` (bridge summarizer) and `OPENAI_API_KEY` (Python answer-gen + judge). Verify model ids in `configs/bedrock.json` (`amazon.nova-2-lite-v1:0` for episodic) and `AMA-Bench/configs/bedrock.yaml` (`qwen.qwen3-32b-v1:0` for answer-gen/judge) match what's available in your region.

All cloud yaml configs (`gpt-5.2.yaml`, `llm_judge_api.yaml`, `bedrock.yaml`, `llm_judge_bedrock.yaml`) read the API key from env — no need to hard-code anywhere.

### 5. Run

```bash
cd contexto/benchmarks/ama-bench
bash scripts/run.sh                 # MODE=bedrock (default) — local embed + Bedrock Qwen

MODE=local   bash scripts/run.sh    # fully self-hosted (needs 4+ GPUs)
MODE=openai  bash scripts/run.sh    # cloud-only
MODE=hybrid  bash scripts/run.sh    # local embed + cloud LLM
```

`run.sh` will:
1. Validate the dependencies for the chosen mode (Ollama running? OpenAI key present?)
2. Start the bridge with the matching `BENCH_CONFIG`
3. Launch VLLM if `LLM_SERVER=vllm`
4. Run AMA-Bench (208 episodes for `openend`)
5. Save results to `AMA-Bench/results/` and shut down the bridge

#### Per-knob overrides

Any individual env var overrides the mode preset, so you can mix:

```bash
# Local VLLM answer-gen + OpenAI judge for comparison
MODE=local JUDGE_SERVER=api JUDGE_CONFIG=$AMA_BENCH/configs/llm_judge_api.yaml \
  bash scripts/run.sh

# Hybrid mode but with a custom bridge config
MODE=hybrid BENCH_CONFIG=./configs/my-experiment.json bash scripts/run.sh

# Disable episodic layer for ablation (point at any preset and edit it,
# or copy a preset and set "episodic": { "enabled": false })
BENCH_CONFIG=./configs/no-episodic.json bash scripts/run.sh
```

Available env vars: `MODE`, `BENCH_CONFIG`, `LLM_SERVER`, `JUDGE_SERVER`, `LLM_CONFIG`, `JUDGE_CONFIG`, `SUBSET`, `BRIDGE_PORT`.

### 6. Episodic summary layer

The bridge runs every turn through an LLM **before** `mindmap.add()`, producing a structured summary (`status`, `summary`, `key_findings`, `evidence_refs`, `open_questions`, `confidence`) that mirrors the production `ekailabs-api-server` behavior. Only the summary (+ formatted key findings) is embedded; raw turn text is kept in `metadata.turn.rawContent` for reference.

Each preset already wires `episodic` correctly:

- `local.json` — Qwen3-32B on local VLLM, `jsonMode: false`, `noThink: true`
- `openai.json` / `hybrid.json` — `gpt-4.1-mini` on OpenAI, `jsonMode: true`
- `bedrock.json` — Qwen3-VL-235B-A22B (`/no_think`) (instruct, ~256k ctx) for the summarizer; `qwen.qwen3-32b-v1:0` (16k ctx) for answer-gen + judge. Same OpenAI-compat endpoint for both, single key. Investigated and ruled out: Amazon Nova (OpenAI-compat path doesn't translate content shape properly), Anthropic Claude (not exposed on OpenAI-compat, would need LiteLLM proxy), Qwen3-Coder variants (coder-tuned → emits empty `key_findings` on trivial turns and treats `/no_think` as user content). The 235B instruct model is only ~47% more expensive than coder-next and cleanly follows the production system prompt.

Knobs:
- `jsonMode` — set `true` for OpenAI-style `response_format: json_object` (works on OpenAI; on VLLM requires `--guided-decoding-backend outlines`). Set `false` and rely on the system prompt's "JSON only" instruction otherwise.
- `noThink: true` — Qwen3 is a hybrid reasoning model; summarization is factual extraction, so we append `/no_think` to skip the thinking phase (saves tokens + latency). Leave off for non-Qwen3 models.
- `apiKey` — optional when `baseUrl` is localhost (VLLM accepts any value); otherwise reads `episodic.apiKey` → `API_KEY` → `OPENAI_API_KEY`.

**Toggle off for ablation:** set `"episodic": { "enabled": false }` in your bench config; raw turn content is embedded directly.

**Cost / volume (`MODE=openai` or `hybrid`):** one `gpt-4.1-mini` call per turn. Full `openend` subset (208 episodes × ~30–100 turns) ≈ 10k–20k summarization calls — pricing varies, check OpenAI's current rate. `MODE=local` is free apart from compute.

### 7. Parameter sweep (optional)

Grid-search over mindmap/search params to find the optimal config:

```bash
bash scripts/sweep.sh
```

Edit `configs/sweep.json` to change ranges. Results are saved to `results/sweep_<timestamp>/sweep_summary.csv`, ranked by accuracy.

## Results

Latest full-benchmark run on the `openend` subset (208 episodes, 2496 questions) using `MODE=bedrock`:

- **Embed**: Ollama `qwen3-embedding:0.6b`
- **Episodic summarizer**: Bedrock `qwen.qwen3-vl-235b-a22b` (`/no_think`, ~256k ctx)
- **Answer-gen**: Bedrock `qwen.qwen3-32b-v1:0`
- **Judge**: Bedrock `qwen.qwen3-32b-v1:0`

### Overall

| Metric | Value |
|---|---|
| Total questions | 2496 |
| Average score | 0.2568 |
| Accuracy | **0.2568** |

### By task type

| Task | Accuracy | Questions |
|---|---:|---:|
| 2048 | 0.1528 | 72 |
| alfworld | 0.1750 | 360 |
| babaisai | 0.4444 | 72 |
| candy_crush | 0.5694 | 72 |
| crafter | 0.3194 | 72 |
| gaia_level1 | 0.3250 | 120 |
| gaia_level2 | 0.2944 | 180 |
| gaia_level3 | 0.5000 | 60 |
| minihack | 0.3472 | 72 |
| spider2 | 0.1454 | 612 |
| swebench | 0.2500 | 432 |
| webarena | 0.3414 | 372 |

### By domain

| Domain | Accuracy | Questions |
|---|---:|---:|
| EMBODIED_AI | 0.1750 | 360 |
| Game | 0.3667 | 360 |
| OPENWORLD_QA | 0.3389 | 360 |
| SOFTWARE | 0.2500 | 432 |
| TEXT2SQL | 0.1454 | 612 |
| WEB | 0.3414 | 372 |

### By QA type

| Type | Accuracy | Questions |
|---|---:|---:|
| A | 0.2622 | 839 |
| B | 0.3003 | 596 |
| C | 0.2581 | 647 |
| D | 0.1812 | 414 |

## Configuration Reference

### Tree construction (`mindmap`)

| Parameter | Default | Description |
|---|---|---|
| `similarityThreshold` | 0.5 | Min cosine similarity to cluster items together |
| `maxDepth` | 4 | Max tree nesting depth |
| `maxChildren` | 10 | Max direct children per node |
| `rebuildInterval` | 50 | Items added before full tree rebuild |

### Retrieval (`search`)

| Parameter | Default | Description |
|---|---|---|
| `maxResults` | 10 | Max items returned |
| `maxTokens` | 4000 | Token budget cap for results |
| `beamWidth` | 3 | Branches explored per tree level |
| `minScore` | 0.0 | Min cosine similarity to include a result |

## Bridge API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check, returns `{ status, activeEpisodes }` |
| `/construct` | POST | Add trajectory items to a mindmap instance |
| `/retrieve` | POST | Search mindmap for relevant context |
| `/reset` | POST | Clear a mindmap instance for an episode |

## File Structure

```
contexto/benchmarks/ama-bench/        # Bridge + config + scripts
├── src/
│   ├── server.ts                     # Bridge server wrapping @ekai/mindmap
│   └── episodic/                     # Production-parity summary layer
│       ├── summary.ts
│       ├── types.ts
│       └── validation.ts
├── package.json
├── tsconfig.json
├── .env                              # OPENAI_API_KEY (not committed)
├── configs/
│   ├── default.json                  # Loaded if BENCH_CONFIG is unset
│   ├── local.json                    # MODE=local preset
│   ├── openai.json                   # MODE=openai preset
│   ├── hybrid.json                   # MODE=hybrid preset
│   ├── bedrock.json                  # MODE=bedrock preset
│   └── sweep.json                    # Parameter sweep ranges
├── scripts/
│   ├── setup.sh                      # One-time setup
│   ├── run.sh                        # Run benchmark (MODE-aware)
│   └── sweep.sh                      # Run parameter sweep
└── results/                          # Benchmark outputs (gitignored)

AMA-Bench/                            # Sibling repo
├── src/method/contexto_method.py     # Python method adapter (thin HTTP client)
├── configs/
│   ├── contexto.yaml                 # Method config (bridge_url only)
│   ├── qwen3-32B.yaml                # VLLM answer-gen
│   ├── llm_judge.yaml                # VLLM judge
│   ├── gpt-5.2.yaml                  # OpenAI answer-gen
│   ├── llm_judge_api.yaml            # OpenAI judge
│   ├── bedrock.yaml                  # Bedrock answer-gen
│   └── llm_judge_bedrock.yaml        # Bedrock judge
├── dataset/                          # Downloaded via huggingface-cli
└── results/                          # Benchmark outputs
```
