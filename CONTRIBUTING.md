# Contributing to Contexto

Thank you for considering contributing! Every contribution, big or small, makes a difference.

## Quick Start

1. **Local setup**: `pnpm install` then `cp .env.example .env` and add one provider key
2. **Development**: `pnpm run dev`
3. **Build**: `pnpm run build` (matches CI)

## Monorepo Structure

Contexto is a pnpm monorepo with the following packages:

| Package | Path | Description |
| --- | --- | --- |
| `@ekai/contexto` | `packages/contexto/` | OpenClaw plugin, context engine |
| `@ekai/mindmap` | `packages/mindmap/` | AGNES hierarchical clustering + beam search |

## Workflow

1. Fork the repo
2. Create a branch (`git checkout -b your-feature`)
3. Make your changes
4. Run `pnpm run build` to catch issues early
5. Push to your fork and create a PR

## Commit Messages

Use conventional commit prefixes when they fit:
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation
- `chore:` — maintenance, dependencies

## What to Contribute

Not sure where to start? We'd love help with:
- [Good first issues](https://github.com/ekailabs/contexto/labels/good%20first%20issue)
- Feature requests
- Documentation improvements
- Bug reports

## Getting Help

- Join our [Discord](https://discord.com/invite/5VsUUEfbJk) for real-time chat
- Create an [issue](https://github.com/ekailabs/contexto/issues) to ask questions or report problems

---

Thank you for taking the time to contribute!
