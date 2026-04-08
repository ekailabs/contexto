# Why AGNES: Hierarchical Clustering for Agent Context

## The Problem

Every AI memory system faces the same fundamental question: **how do you organize memories so retrieval is fast, relevant, and context-aware?**

Most systems default to flat vector search — embed everything, store it in a vector DB, and retrieve the top-k nearest neighbors. This works for simple lookups, but breaks down for agent context management where you need:

- **Multi-resolution retrieval** — sometimes you need a broad topic summary, sometimes a specific detail
- **Token-budget-aware retrieval** — you can't just return top-k; you need to fill a fixed context window efficiently
- **Semantic organization** — related memories should be grouped, not scattered across an unstructured index
- **No pre-defined categories** — agent conversations span unpredictable topics; you can't hardcode a taxonomy

## What Others Do

We surveyed the major AI memory systems to understand the landscape:

### Mem0

Uses **pluggable vector stores** (Qdrant, pgvector, Pinecone, etc.) with HNSW or DiskANN indexing. Memories are stored as **flat atomic facts** with an optional Neo4j/Kuzu knowledge graph layer. Consolidation is LLM-driven — on each insert, an LLM decides whether to ADD, UPDATE, DELETE, or NOOP against existing memories.

**Structure**: Flat facts + optional entity graph. No clustering.

### Supermemory

Built on **pgvector** with hybrid search (semantic + fact retrieval). Memories are flat atomic facts scoped by projects. Uses Anthropic's Contextual Retrieval technique for chunking. Supports contradiction resolution and stale information expiration.

**Structure**: Flat facts + document chunks. No clustering.

### Zep (Graphiti)

The most sophisticated graph-based approach. Uses a **temporal knowledge graph** backed by Neo4j with triple parallel retrieval: cosine similarity, BM25 full-text search, and breadth-first graph traversal. Entities are clustered into communities via **dynamic label propagation** — the closest thing to clustering in this space.

**Structure**: Temporal knowledge graph with flat community clustering. Not hierarchical.

### LangChain / LangGraph Memory

Stores memories as **JSON documents** in developer-defined namespace hierarchies (e.g., `("user", "123", "memories")`). Backed by pgvector (HNSW/IVFFlat) or SQLite with sqlite-vec. Consolidation uses a memory enrichment process that balances creation vs. update.

**Structure**: Flat key-value store with static namespace organization. No dynamic clustering.

### Letta (formerly MemGPT)

Models memory after **OS memory management** with three tiers: core memory (in-context, agent-editable), recall memory (conversation log), and archival memory (vector DB — ChromaDB or pgvector). The agent self-manages what goes where via tool calls. Context window overflow triggers conversation summarization.

**Structure**: Fixed 3-tier architecture. No clustering within tiers.

### Summary

| System | Index | Memory Structure | Clustering | Consolidation |
|--------|-------|-----------------|------------|---------------|
| **Mem0** | HNSW / DiskANN | Flat facts + knowledge graph | None | LLM-driven ADD/UPDATE/DELETE |
| **Supermemory** | pgvector | Flat facts + doc chunks | None | Contradiction resolution + expiry |
| **Zep** | Neo4j vectors + BM25 + BFS | Temporal knowledge graph | Label propagation (flat) | Temporal invalidation + LLM dedup |
| **LangGraph** | HNSW / IVFFlat | JSON docs in static namespaces | None | Memory enrichment + TTL |
| **Letta** | ChromaDB (HNSW) / pgvector | 3-tier: core / recall / archival | None | Summarization + agent self-editing |
| **Contexto** | **AGNES dendrogram** | **Dynamic semantic hierarchy** | **Hierarchical (agglomerative)** | Algorithmic + incremental centroid |

**Key finding**: No major AI memory system uses hierarchical clustering. All rely on flat similarity search, with Zep being the only one adding flat community detection via label propagation. Memory consolidation across the board is LLM-driven rather than algorithmic.

---

## Why Hierarchical Clustering?

### Over flat ANN (HNSW, IVFFlat)

Approximate Nearest Neighbor indices like HNSW are excellent for raw retrieval speed. They're what most vector databases use internally. But they solve a different problem:

| | Flat ANN (HNSW) | Hierarchical Clustering |
|---|---|---|
| **Query type** | "Find the k most similar items" | "Find all items in the most relevant semantic branch" |
| **Structure** | Flat index, no organization | Semantic tree with labeled clusters |
| **Token budgeting** | Return top-k, hope it fits | Beam search fills budget by exploring branches |
| **Multi-resolution** | No — always item-level | Yes — can retrieve at cluster or item level |
| **Interpretability** | Opaque index | Labeled tree (travel → Japan trip → visa documents) |
| **Pruning** | Must score candidates | Prune entire branches by centroid similarity |

HNSW answers "what's similar?" — hierarchical clustering answers "what's this about, and what details matter?"

For agent context, the second question is more useful. You don't just want the 7 most similar messages; you want the most relevant *topic branches* packed into your token budget.

### Over K-Means

K-means is the default clustering algorithm most engineers reach for. If you're going to cluster, why not the simpler algorithm? Because K-Means produces flat partitions; hierarchical clustering produces a dendrogram — a tree you can cut at any level.

#### 1. You must specify k upfront

K-means requires choosing the number of clusters before running. Agent conversations are open-ended — a session might touch 3 topics or 30. Choosing k=5 when there are 15 natural topics merges unrelated episodes; choosing k=15 when there are 3 fragments coherent topics into noise.

Hierarchical clustering discovers the natural cluster count by cutting the dendrogram at a similarity threshold. No k needed.

#### 2. Spherical cluster assumption

K-means assumes clusters are roughly spherical and equally sized in embedding space. Conversational topics are neither — a 50-message thread and a 3-message question are both valid clusters but wildly different in density.

Hierarchical clustering with average linkage handles variable-density clusters naturally because it merges based on average pairwise distance, not distance to a centroid.

#### 3. No hierarchy

K-means produces a flat partition. You get k buckets with no relationship between them. This means:

- No multi-resolution retrieval (can't zoom in/out)
- No branch pruning during search (must check all k centroids)
- No interpretable structure (which clusters are subtopics of which?)

Hierarchical clustering produces a dendrogram — a full hierarchy from individual items up to a single root. We cut it at our similarity threshold to get the right granularity, but the hierarchy is preserved for navigation.

#### 4. Instability

K-means results depend on random initialization. Run it twice on the same data and you may get different clusters. This is unacceptable for a context system where users expect consistent retrieval behavior.

Hierarchical clustering is deterministic — same data, same tree, every time.

#### 5. No incremental updates

Standard k-means requires re-running on the full dataset when new items arrive. Mini-batch k-means exists but still shifts centroids unpredictably.

Our implementation supports **greedy incremental insertion** — new items walk the existing tree and slot into the best-matching branch in O(log N) time, with O(d) centroid updates.

---

## Why AGNES Specifically?

Among hierarchical clustering algorithms, we chose [AGNES (Agglomerative Nesting)](https://onlinelibrary.wiley.com/doi/book/10.1002/9780470316801) (Kaufman & Rousseeuw, 1990) with [average linkage (UPGMA)](https://www.semanticscholar.org/paper/A-statistical-method-for-evaluating-systematic-Sokal-Michener/0db093335bc3b9445fa5a1a5526d634921d7b59a) (Sokal & Michener, 1958) for specific reasons:

### Agglomerative vs. Divisive

- **AGNES (bottom-up)**: Start with individual items, merge the closest pairs upward. Produces fine-grained leaf clusters that accurately reflect local similarity.
- **DIANA (top-down)**: Start with everything in one cluster, split recursively. Better for finding large-scale structure but can make poor early splits that propagate.

For agent context, **local accuracy matters more than global structure**. A user asking about "OAuth token refresh" needs the system to find the tight cluster of auth-related messages, not a broad "security" supercluster. AGNES gets this right because it builds from the leaves up.

### Why Average Linkage (UPGMA)?

The linkage method determines how inter-cluster distance is measured during merges:

| Linkage | Distance Between Clusters | Behavior |
|---------|--------------------------|----------|
| **Single** | Minimum pairwise distance | Chaining — long, stringy clusters. One tangentially related message pulls two unrelated topics together |
| **Complete** | Maximum pairwise distance | Compact but tends to split natural clusters. A single outlier message forces a premature split |
| **Average (UPGMA)** | Mean of all pairwise distances | Balanced — cohesive clusters that tolerate some variance without chaining |
| **Ward's** | Minimizes total within-cluster variance | Prefers equal-sized clusters — not ideal when one topic has 50 messages and another has 3 |

Average linkage is the right trade-off for conversational data where topic sizes vary naturally and you want cohesive-but-not-rigid groupings.

---

## How It Works in Contexto

### Building the Tree

```
Conversation items (with embeddings)
  ↓
Pairwise cosine distance matrix
  ↓
AGNES with average linkage (via ml-hclust)
  ↓
Dendrogram
  ↓
Cut at similarity threshold (0.65)
  ↓
ClusterNode tree (max depth 4)
```

Each `ClusterNode` stores:
- **Centroid** — average embedding of all items in the subtree
- **Label** — auto-generated from most representative keywords
- **Items** — leaf-level conversation items
- **Children** — sub-clusters

The result is a navigable semantic hierarchy. Each leaf is an **episode** — a full conversation turn containing the user message, assistant response, and any tool outputs bundled together. Consider an AI assistant used across weeks of varied conversations — the tree self-organizes from these episodes, regardless of domain:

```
root (Knowledge)
├── [travel planning & logistics]                      ← 19 episodes, depth 1
│   ├── [Japan trip itinerary]                         ← 8 episodes, depth 2
│   │   ├── Episode: User asked about 3-week Japan route
│   │   │   → Assistant planned Tokyo → Kyoto → Osaka → Hiroshima
│   │   │     with transit times and suggested stays per city
│   │   ├── Episode: User compared JR Pass options
│   │   │   → Assistant broke down 21-day JR Pass vs individual
│   │   │     shinkansen tickets with cost analysis
│   │   ├── Episode: User asked for ryokan recommendations
│   │   │   → Assistant suggested 3 ryokans near Arashiyama
│   │   │     with prices, booking links, and onsen details
│   │   └── Episode: User asked about vegetarian dining in Shibuya
│   │       → Assistant listed 5 restaurants with menus, price
│   │         ranges, and reservation requirements
│   ├── [visa & travel documents]                      ← 6 episodes, depth 2
│   │   ├── Episode: User asked about passport renewal timeline
│   │   │   → Assistant calculated 6-week processing, deadline March 10
│   │   ├── Episode: User checked Japan visa requirements
│   │   │   → Assistant confirmed visa waiver for US citizens,
│   │   │     90-day max, entry requirements and customs forms
│   │   └── Episode: User compared travel insurance providers
│   │       → Assistant compared World Nomads vs SafetyWing
│   │         coverage, deductibles, and adventure sports policy
│   └── [packing & budget]                             ← 5 episodes, depth 2
│       ├── Episode: User asked for full trip budget estimate
│       │   → Assistant built spreadsheet: flights $1200, rail $450,
│       │     accommodation $1800, food $500, activities $250 = $4200
│       └── Episode: User asked about connectivity options
│           → Assistant compared portable WiFi rental vs eSIM
│             providers with coverage maps and daily costs
│
├── [health & fitness]                                 ← 15 episodes, depth 1
│   ├── [running training plan]                        ← 7 episodes, depth 2
│   │   ├── Episode: User set goal for half marathon in 10 weeks
│   │   │   → Assistant built progressive plan from 15 mi/week base
│   │   │     with tempo, interval, and long run schedule
│   │   ├── Episode: User asked about tempo run pacing
│   │   │   → Assistant calculated 8:30/mile threshold pace from
│   │   │     recent 5K time, explained RPE and heart rate zones
│   │   ├── Episode: User asked about race-day nutrition
│   │   │   → Assistant recommended gel every 45 min after mile 6,
│   │   │     electrolyte strategy, and pre-race meal timing
│   │   └── Episode: User reported hip flexor tightness
│   │       → Assistant suggested 4 stretches, foam rolling routine,
│   │         and when to reduce training load vs push through
│   ├── [meal planning & nutrition]                    ← 5 episodes, depth 2
│   │   ├── Episode: User asked for high-protein vegetarian meals
│   │   │   → Assistant created 5-day meal plan with macros:
│   │   │     lentil soup, quinoa bowls, tofu stir-fry, tempeh tacos
│   │   └── Episode: User concerned about iron on plant-based diet
│   │       → Assistant explained iron + B12 supplementation,
│   │         food pairing for absorption, and blood test schedule
│   └── [sleep & recovery]                             ← 3 episodes, depth 2
│       ├── Episode: User reported sleep dropping to 6hrs
│       │   → Assistant suggested magnesium glycinate dosage,
│       │     sleep hygiene adjustments, and training load reduction
│       └── Episode: User asked about recovery on rest days
│           → Assistant outlined active recovery protocol:
│             light walking, stretching, hydration targets
│
├── [career & job search]                              ← 14 episodes, depth 1
│   ├── [resume & applications]                        ← 6 episodes, depth 2
│   │   ├── Episode: User asked to rewrite resume for PM roles
│   │   │   → Assistant rewrote 4 bullet points with quantified impact:
│   │   │     "grew DAU 40% in 6 months" instead of "managed growth"
│   │   └── Episode: User drafted cover letter for Stripe
│   │       → Assistant tailored letter emphasizing payments experience,
│   │         API design background, and growth metrics
│   ├── [interview preparation]                        ← 5 episodes, depth 2
│   │   ├── Episode: User practiced behavioral questions
│   │   │   → Assistant walked through STAR format with 3 example
│   │   │     answers tailored to user's payments experience
│   │   └── Episode: User asked for system design practice
│   │       → Assistant ran mock interview: "design a notification
│   │         service at scale" with follow-up questions and feedback
│   └── [salary & negotiation]                         ← 3 episodes, depth 2
│       ├── Episode: User asked about SF PM compensation
│       │   → Assistant provided market data ($180-220k base + equity),
│       │     negotiation scripts, and counter-offer strategy
│       └── Episode: User received initial offer
│           → Assistant analyzed offer breakdown, suggested countering
│             at 15% above base with equity acceleration ask
│
├── [home improvement & DIY]                           ← 11 episodes, depth 1
│   ├── [kitchen renovation]                           ← 6 episodes, depth 2
│   │   ├── Episode: User compared countertop materials
│   │   │   → Assistant analyzed quartz vs granite on cost, porosity,
│   │   │     heat resistance, and long-term maintenance
│   │   ├── Episode: User shared contractor quote of $28k
│   │   │   → Assistant benchmarked against 120 sqft averages,
│   │   │     flagged missing line items, suggested counter questions
│   │   └── Episode: User asked about backsplash tile layout
│   │       → Assistant explained herringbone pattern needs 15% more
│   │         tiles than straight lay, provided calculation and diagram
│   ├── [smart home setup]                             ← 3 episodes, depth 2
│   │   ├── Episode: User compared smart switch protocols
│   │   │   → Assistant compared Zigbee vs Z-Wave vs WiFi on range,
│   │   │     power draw, mesh reliability, and Home Assistant support
│   │   └── Episode: User asked about Home Assistant hardware
│   │       → Assistant compared Raspberry Pi vs mini PC on cost,
│   │         reliability, addon support, and power consumption
│   └── [garden & outdoor]                             ← 2 episodes, depth 2
│       └── Episode: User planned raised bed vegetable garden
│           → Assistant recommended soil mix 1:1:1 topsoil:compost:perlite,
│             bed dimensions, and seasonal planting schedule
│
├── [personal finance]                                 ← 10 episodes, depth 1
│   ├── [investment strategy]                          ← 5 episodes, depth 2
│   │   ├── Episode: User asked about portfolio allocation
│   │   │   → Assistant explained three-fund approach (US total market,
│   │   │     international, bonds) with age-based allocation ratios
│   │   └── Episode: User asked about tax optimization
│   │       → Assistant explained Roth IRA $7000 limit, tax-loss
│   │         harvesting strategy, and wash sale rule timing
│   └── [budgeting & expenses]                         ← 5 episodes, depth 2
│       ├── Episode: User asked for monthly budget breakdown
│       │   → Assistant categorized: rent $2400, food $600, transit $120,
│       │     subscriptions $85, discretionary $400 — identified savings gaps
│       └── Episode: User asked for emergency fund target
│           → Assistant calculated 6 months of expenses ($21k),
│             suggested high-yield savings accounts, and built timeline
│
└── [learning & side projects]                         ← 8 episodes, depth 1
    ├── [Rust programming]                             ← 5 episodes, depth 2
    │   ├── Episode: User learning ownership and borrowing
    │   │   → Assistant explained with examples, reframed compiler
    │   │     errors as learning tool, built mental model from C++ analogues
    │   ├── Episode: User building CLI for markdown-to-epub
    │   │   → Assistant helped with clap argument parsing, file I/O
    │   │     with std::fs, and epub chapter structure
    │   └── Episode: User asked about async in Rust
    │       → Assistant compared Tokio runtime vs std::thread for
    │         file I/O workload, recommended std::thread for this case
    └── [photography]                                  ← 3 episodes, depth 2
        ├── Episode: User asked about street photography settings
        │   → Assistant explained aperture priority mode, ISO auto
        │     range, and zone focusing technique for candid shots
        └── Episode: User wanted to create a film look preset
            → Assistant walked through Lightroom adjustments: lift
              blacks, warm highlights, fade curve, grain amount
```

Notice how the tree reflects the *natural topology of conversations* — not a pre-defined taxonomy. The agent never asked "what categories do you want?" — it discovered that Japan trip planning, visa logistics, and budgeting are related because the episode embeddings cluster in semantic space. A two-episode tangent about garden soil doesn't get its own top-level branch; it nests under home improvement where it belongs. The running training plan and meal planning land together under health, even though those conversations happened weeks apart.

The structure also reveals cross-domain connections that flat retrieval would miss. When the user asks "what should I eat the week before my race while staying in budget?", beam search descends into `health → meal planning`, `health → running training`, and `personal finance → budgeting` simultaneously — surfacing full episodes from three branches in a single retrieval pass. The agent gets back not just isolated facts, but the complete conversational context: the meal plan with macros, the race nutrition strategy, and the monthly food budget.

### Hybrid Rebuild Strategy

Full AGNES is O(n^2) — fine for small trees, expensive at scale. We use a hybrid approach:

| Condition | Strategy | Why |
|-----------|----------|-----|
| Total items < 100 | Full rebuild | Cheap enough, optimal structure |
| Inserts since rebuild >= 50 | Full rebuild | Accumulated drift from incremental inserts |
| Otherwise | Incremental insertion | O(log N) per item, keeps latency low |

Incremental insertion walks the tree top-down, following the highest-similarity child at each level. If no child exceeds the threshold, a new sibling cluster is created. Centroids update in O(d):

```
newCentroid[i] = (oldCentroid[i] * oldCount + newVector[i]) / (oldCount + 1)
```

### Retrieval: Multi-Branch Beam Search

The hierarchy enables [**beam search**](https://www.semanticscholar.org/paper/The-HARPY-speech-recognition-system-Lowerre/bdb3f20fe41bb95f6bc9d162e827de8db3f952d7) (Lowerre, 1976) — exploring multiple promising branches simultaneously:

```
Level 0:  root
Level 1:  [auth: 0.82]  [deploy: 0.71]  [testing: 0.58]   ← keep top 3
Level 2:  [oauth: 0.85]  [k8s: 0.68]  [ci-cd: 0.61]       ← expand & re-rank
Level 3:  ... collect terminal items
```

This is fundamentally different from flat top-k retrieval:
- **Branch pruning** — skip irrelevant subtrees entirely
- **Token budgeting** — fill the context window by expanding branches until budget is exhausted
- **Path tracing** — know *why* an item was retrieved (e.g., `auth → oauth → token refresh`)

---

## The Case for Hierarchical Clustering in Agent Context

Agent context management has unique requirements that align with hierarchical clustering:

**1. Conversations are inherently hierarchical.** A debugging session has subtopics (error diagnosis, fix attempts, verification). A planning session has phases (requirements, design, implementation). Flat storage discards this structure; a tree preserves it.

**2. Token budgets demand intelligent packing.** You can't just return top-k similar items — you need to fill a fixed token window with the most relevant *coverage*. Beam search over a hierarchy naturally provides this by expanding the most promising branches until the budget is full.

**3. Topics emerge dynamically.** Unlike document retrieval where categories are known upfront, agent conversations create new topics in real-time. AGNES discovers these topics algorithmically from the embedding space — no pre-defined taxonomy needed.

**4. Deduplication is structural.** Items within the same cluster are semantically related by definition. This makes deduplication and consolidation natural — you don't need an LLM to decide if two memories overlap; the tree already groups them together.

**5. Retrieval should be explainable.** When an agent injects recalled context, it helps to know the retrieval path (`deploy → k8s → helm config`). Hierarchical clustering provides this for free; flat vector search cannot.

---

## Trade-offs and Limitations

We're not claiming AGNES is universally superior. The trade-offs are real:

| Aspect | AGNES | Flat Vector Search |
|--------|-------|--------------------|
| **Build cost** | O(n^2) full rebuild (periodic) | O(n log n) index build |
| **Between rebuilds** | O(log N) incremental insert | O(log n) insert |
| **Query latency** | O(beam * depth) | O(log n) with HNSW |
| **Memory overhead** | Tree + centroids + items | Index + items |
| **Scale** | Thousands to tens of thousands (incremental beyond) | Millions of items |
| **Best for** | Structured, budget-aware context retrieval | Raw similarity search at scale |

Full AGNES rebuilds are O(n^2) — at 10k items that's ~100M distance computations (seconds), but at 100k items the distance matrix alone would need ~80GB of memory. In practice, full rebuilds are for smaller trees (thousands of items). Beyond that, the system relies on incremental insertion (O(log N) per item), which accumulates some structural drift but keeps latency low. The rebuild interval is configurable to balance structure quality vs. cost.

AGNES is the right tool for **agent context windows** — token-budget-constrained, structure-aware retrieval at conversational scale. It is not trying to replace HNSW for million-scale document retrieval.

---

## References

- Kaufman, L. & Rousseeuw, P.J. (1990). [*Finding Groups in Data: An Introduction to Cluster Analysis*](https://onlinelibrary.wiley.com/doi/book/10.1002/9780470316801), Chapter 5 (AGNES). Wiley Series in Probability and Statistics.
- Sokal, R.R. & Michener, C.D. (1958). [A statistical method for evaluating systematic relationships](https://www.semanticscholar.org/paper/A-statistical-method-for-evaluating-systematic-Sokal-Michener/0db093335bc3b9445fa5a1a5526d634921d7b59a). *University of Kansas Science Bulletin*, 38, 1409–1438. (UPGMA / average linkage)
- Lowerre, B.T. (1976). [*The HARPY Speech Recognition System*](https://www.semanticscholar.org/paper/The-HARPY-speech-recognition-system-Lowerre/bdb3f20fe41bb95f6bc9d162e827de8db3f952d7). PhD thesis, Carnegie Mellon University. (Origin of beam search)
- Salton, G., Wong, A. & Yang, C.S. (1975). [A vector space model for automatic indexing](https://dl.acm.org/doi/10.1145/361219.361220). *Communications of the ACM*, 18(11), 613–620. (Cosine similarity)
- [`ml-hclust`](https://github.com/mljs/hclust) — JavaScript hierarchical clustering library (MIT)
