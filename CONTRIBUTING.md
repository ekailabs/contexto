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

We use [Conventional Commits](https://www.conventionalcommits.org/) with **package scopes**. Releases are auto-detected from squash merge commit messages (PR titles), so getting the format right matters.

### Format

```
<type>(<scope>): <description>
```

### Scopes

Use the package name as the scope:

| Scope | Package |
| --- | --- |
| `contexto` | `@ekai/contexto` |
| `mindmap` | `@ekai/mindmap` |

Omit the scope for repo-wide changes (CI, root config, docs).

### Types

**Triggers a release:**

| Type | Bump | Description |
| --- | --- | --- |
| `feat` | minor | New feature |
| `fix` | patch | Bug fix |
| `perf` | patch | Performance improvement |
| `refactor` | patch | Code restructuring, no behavior change |

**No release:**

| Type | Description |
| --- | --- |
| `docs` | Documentation only |
| `chore` | Maintenance, dependencies |
| `test` | Adding or updating tests |
| `ci` | CI/CD changes |
| `style` | Formatting, whitespace |
| `build` | Build system changes |

### Breaking changes

Append `!` after the scope to signal a **major** version bump:

```
feat(contexto)!: redesign plugin config
fix(mindmap)!: change ClusterNode shape
```

### Examples

```
feat(contexto): add sliding window compaction
fix(mindmap): beam search depth limiting
feat(contexto)!: remove legacy v0 config
docs: update README architecture section
chore: bump pnpm to v9
```

### PR titles

Since we squash merge, the **PR title becomes the commit message** on main. Use the same format for PR titles. The CI release workflow reads these to auto-detect version bumps.

## Releases

Releases are powered by [semantic-release](https://github.com/semantic-release/semantic-release) via [multi-semantic-release](https://github.com/dhoulb/multi-semantic-release). Maintainers trigger them manually from the GitHub Actions UI.

### How to release

1. Go to **Actions** tab on GitHub
2. Select the **CI** workflow
3. Click **Run workflow**
4. Pick the package (`contexto`, `mindmap`, or `all`)
5. Optionally enable **dry run** to preview without publishing

### What happens

semantic-release will:
1. Analyze commits since the last release tag for that package (by file path, not just commit scope)
2. Auto-detect the bump type (`feat` = minor, `fix`/`perf`/`refactor` = patch, `!` = major)
3. Skip if no releasable commits (`docs`, `chore`, `test`, `ci`, `style`, `build` don't trigger releases)
4. Bump the version in `package.json`
5. Generate a `CHANGELOG.md` grouped by type (Features, Bug Fixes, Performance, Refactoring)
6. Publish to npm
7. Commit version bump + changelog with `[skip ci]`
8. Create a git tag (e.g., `@ekai/contexto@0.1.12`) and GitHub Release

### When to release

- **Not every PR needs a release.** Batch related changes and release when ready.
- **Use `all` when both packages changed together** (e.g., mindmap API change that contexto depends on).
- If a package has no releasable commits, it's skipped automatically.

### Forcing a release

There is no manual bump override. The version is always derived from commits:
- To force a **major** bump: use `feat(pkg)!:` or add a `BREAKING CHANGE:` footer
- To force a release with no real changes: `git commit --allow-empty -m "fix(contexto): trigger release"`

### Prerequisites

- `NPM_TOKEN` must be set in repo secrets (Settings > Secrets > Actions)
- Only maintainers with write access can trigger workflow dispatch

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
