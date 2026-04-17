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

- [Bun](https://bun.sh) >= 1.0
- Python >= 3.9
- pnpm
- `huggingface-cli` (`pip install huggingface_hub`)
- An API key for [OpenRouter](https://openrouter.ai) or OpenAI (used for embeddings + LLM)

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

Or run the setup script which does all of the above:

```bash
cd contexto/benchmarks/ama-bench
bash scripts/setup.sh
```

### 3. Configure the bridge

Create `contexto/benchmarks/ama-bench/.env`:

```bash
# Embedding API key (used by the bridge for mindmap embeddings)
API_KEY=your-openrouter-or-openai-key
```

Tune mindmap parameters in `contexto/benchmarks/ama-bench/configs/default.json`:

```json
{
  "provider": "openrouter",
  "embedModel": "openai/text-embedding-3-small",
  "mindmap": {
    "similarityThreshold": 0.5,
    "maxDepth": 4,
    "maxChildren": 10,
    "rebuildInterval": 50
  },
  "search": {
    "maxResults": 10,
    "maxTokens": 4000,
    "beamWidth": 3,
    "minScore": 0.0
  }
}
```

### 4. Configure AMA-Bench LLM

AMA-Bench needs an LLM config for answer generation and a judge config for scoring. Create these in `AMA-Bench/configs/`:

```yaml
# AMA-Bench/configs/openrouter.yaml
provider: "openai"
api_key: "your-openrouter-key"
model: "openai/gpt-4o"
base_url: "https://openrouter.ai/api/v1"
max_tokens: 16000
temperature: 0.0
```

```yaml
# AMA-Bench/configs/llm_judge_openrouter.yaml
provider: "openai"
api_key: "your-openrouter-key"
model: "openai/gpt-4o"
base_url: "https://openrouter.ai/api/v1"
max_tokens: 16000
temperature: 0.0
```

### 5. Run

```bash
cd contexto/benchmarks/ama-bench
bash scripts/run.sh
```

This will:
1. Start the bridge server (reads `configs/default.json` + `API_KEY` from `.env`)
2. Run AMA-Bench with the `contexto` method (208 episodes, ~35s each)
3. Evaluate answers with the LLM judge
4. Save results to `AMA-Bench/results/`
5. Shut down the bridge

Override defaults:

```bash
LLM_CONFIG=../../../AMA-Bench/configs/openrouter.yaml \
JUDGE_CONFIG=../../../AMA-Bench/configs/llm_judge_openrouter.yaml \
SUBSET=openend \
bash scripts/run.sh
```

### 6. Parameter sweep (optional)

Grid-search over mindmap/search params to find the optimal config:

```bash
bash scripts/sweep.sh
```

Edit `configs/sweep.json` to change ranges. Results are saved to `results/sweep_<timestamp>/sweep_summary.csv`, ranked by accuracy.

## Running with Docker Compose

No local Bun or Python needed. Everything runs in containers.
TODO: fix errors on pip installation

```bash
cd contexto/benchmarks/ama-bench/docker
cp .env.example .env   # set API_KEY
docker compose up --build
```

The `bridge` container starts the server, the `runner` container clones AMA-Bench, downloads the dataset, and runs the benchmark.

### CI

```yaml
- name: Run AMA-Bench
  working-directory: benchmarks/ama-bench/docker
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: docker compose up --build --abort-on-container-exit
```

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
contexto/benchmarks/ama-bench/       # Bridge + config + scripts
├── src/server.ts                    # Bridge server wrapping @ekai/mindmap
├── package.json
├── tsconfig.json
├── .env                             # API_KEY (not committed)
├── configs/
│   ├── default.json                 # Mindmap + search parameters
│   └── sweep.json                   # Parameter sweep ranges
├── scripts/
│   ├── setup.sh                     # One-time setup
│   ├── run.sh                       # Run benchmark
│   └── sweep.sh                     # Run parameter sweep
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile                   # AMA-Bench runner
│   ├── bridge.Dockerfile            # Bridge server
│   └── .env.example
└── results/                         # Benchmark outputs (gitignored)

AMA-Bench/                           # Fork of AMA-Bench
├── src/method/contexto_method.py    # Python method adapter (thin HTTP client)
├── configs/
│   ├── contexto.yaml                # Method config (bridge_url only)
│   ├── openrouter.yaml              # LLM config for answer generation
│   └── llm_judge_openrouter.yaml    # LLM config for judge scoring
├── dataset/                         # Downloaded via huggingface-cli
└── results/                         # Benchmark outputs
```
