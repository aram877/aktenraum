# ADR-001: Monorepo Tooling — pnpm Workspaces

**Status**: Accepted

## Context

aktenraum is a monorepo containing a Python service (`services/auto-tagger`), a future React/Next.js frontend (`apps/web`), shell scripts, and Docker configuration. We need a way to manage Node packages across workspaces and provide a consistent developer entrypoint.

Options considered:
- **pnpm workspaces** — built-in to pnpm; no extra tooling, shared dependency hoisting, workspace-aware `pnpm --filter` commands.
- **Turborepo** — adds build caching and a task execution graph on top of pnpm or npm workspaces. Valuable when multiple packages need to build in a specific order with caching in CI.
- **Nx** — full monorepo platform with code generation, affected-file detection, and a plugin ecosystem. Significant complexity overhead.

## Decision

We will use **pnpm workspaces** with no additional build orchestration tool. `pnpm-workspace.yaml` declares `apps/*` and `services/*`. The Python service is a workspace member by directory convention only; its own tooling is `uv`.

## Consequences

- Simple: one config file, no extra dependencies, no CI plugin setup.
- `pnpm install` from root hoists shared Node packages and links workspaces.
- No build caching between packages — acceptable because `apps/web` has no implementation in v1 and `services/auto-tagger` is Python.
- If build times become a problem after the frontend is implemented, Turborepo can be added on top of pnpm workspaces without restructuring the repo.
