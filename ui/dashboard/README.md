# Ekai Memory Vault Dashboard

A dashboard for managing agent memory and exploring the knowledge graph.

## Features

- **Memory Management**: View, edit, and delete memories across episodic, semantic, procedural, and reflective sectors
- **Knowledge Graph**: Interactive visualization of entity relationships and triples
- **Profile Support**: Switch between memory profiles
- **Semantic Graph Explorer**: Traverse paths, neighbors, and connections between entities

## Getting Started

### Prerequisites
- Node.js 18+
- Memory service running (embedded in OpenRouter on port 4010)

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the development server:**
   ```bash
   npm run dev
   ```

3. **Open your browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

### Optional: Environment Configuration

The dashboard automatically detects the host from the browser URL and connects to the memory API (port 4010) on the same host. No configuration is needed for standard deployments.

To override, set these in `.env`:

```bash
NEXT_PUBLIC_MEMORY_PORT=4010   # Memory API port
NEXT_PUBLIC_EMBEDDED_MODE=true # When UI is served from the same Express server
```

## API Integration

The dashboard connects to the memory API through these endpoints:

- `GET /v1/summary` — Fetch memory sector summaries and recent items
- `PUT /v1/memory/:id` — Update a memory
- `DELETE /v1/memory/:id` — Delete a memory
- `DELETE /v1/memory` — Delete all memories
- `GET /v1/graph/visualization` — Graph visualization data
- `GET /v1/graph/triples` — Query triples for an entity
- `GET /v1/graph/neighbors` — Get entity neighbors
- `GET /v1/graph/paths` — Find paths between entities
- `GET /v1/profiles` — List memory profiles
- `DELETE /v1/profiles/:name` — Delete a profile
- `DELETE /v1/graph/triple/:id` — Delete a graph triple

## Code Organization
```
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx            # Redirects to /memory
│   ├── globals.css
│   └── memory/
│       └── page.tsx        # Memory vault page
├── components/
│   ├── memory/             # Memory-specific components
│   └── ui/
│       ├── LoadingSkeleton.tsx
│       └── ErrorState.tsx
└── lib/
    ├── api.ts              # API service functions
    └── constants.ts        # Port and URL config
```

## Technology Stack

- **Next.js** — React framework with App Router
- **TypeScript** — Type-safe development
- **Tailwind CSS** — Utility-first CSS framework

## Development

### Available Scripts

- `npm run dev` — Start development server
- `npm run build` — Build for production
- `npm run start` — Start production server
- `npm run lint` — Run ESLint
- `npm run type-check` — Run TypeScript type checking

## License

This project is part of the Ekai Gateway ecosystem.
