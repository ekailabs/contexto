# AMA-Bench Benchmark for @ekai/mindmap

Benchmarks the `@ekai/mindmap` package against [AMA-Bench](https://github.com/ekailabs/AMA-Bench), an evaluation framework for Associative Memory Ability in AI agents.

## Architecture

```
AMA-Bench (Python)                    Bridge Server (TypeScript)
┌──────────────────────┐              ┌──────────────────────────-┐
│ run.py               │              │ server.ts                 │
│   └─ ContextoMethod  │   HTTP       │   └─ @ekai/mindmap        │
│       │              │──────────────▶       ├─ mindmap.add()    │
│       │ construct    │ /construct   │       │  (embed+cluster)  │
│       │ retrieve     │ /retrieve    │       └─ mindmap.search() │
│       ▼              │              │          (beam search)    │
│ LLM generates answer │              │                           │
│ Judge scores answer  │              │ reads configs/default.json│
└──────────────────────┘              └──────────────────────────-┘
```

The bridge server owns all mindmap configuration (`configs/default.json`) and the embedding API key (`API_KEY` env var). The Python method is a thin HTTP client that sends trajectory data and questions.

## Quick Start (Docker Compose)

No local Bun or Python needed.

```bash
cd docker
cp .env.example .env   # set API_KEY for embeddings
docker compose up --build
```

Override defaults:

```bash
SUBSET=mcq LLM_CONFIG=claude-sonnet.yaml docker compose up --build
```

### CI

```yaml
- name: Run AMA-Bench
  working-directory: benchmarks/ama-bench/docker
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: docker compose up --build --abort-on-container-exit
```

## Local Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- Python >= 3.9
- pnpm (for workspace install)
- `huggingface-cli` (for dataset download)

### Install

```bash
bash scripts/setup.sh
```

### Configure

1. Edit `configs/default.json` — provider, embed model, mindmap and search params
2. Set your embedding API key:
   ```bash
   export API_KEY=your-openrouter-or-openai-key
   ```

### Run benchmark

```bash
bash scripts/run.sh
```

Override AMA-Bench options:

```bash
LLM_CONFIG=/path/to/llm.yaml SUBSET=openend bash scripts/run.sh
```

### Run parameter sweep

Grid-search over mindmap/search params:

```bash
bash scripts/sweep.sh
```

Edit `configs/sweep.json` to change the parameter ranges. Results are saved to `results/sweep_<timestamp>/sweep_summary.csv`, ranked by accuracy.

## Configuration

All mindmap parameters are in `configs/default.json`:

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
benchmarks/ama-bench/
├── src/server.ts                   # Bridge server wrapping @ekai/mindmap
├── package.json
├── configs/
│   ├── default.json                # Mindmap + search parameters
│   └── sweep.json                  # Parameter sweep ranges
├── scripts/
│   ├── setup.sh                    # One-time setup
│   ├── run.sh                      # Run benchmark
│   └── sweep.sh                    # Run parameter sweep
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile                  # AMA-Bench runner
│   ├── bridge.Dockerfile           # Bridge server
│   └── .env.example
└── results/                        # Benchmark outputs (gitignored)
```
