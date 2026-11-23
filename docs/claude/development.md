# Development workflow and tests

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

## Development workflow

One pnpm workspace, one lockfile, four packages. Run everything from the **repository root**.

```bash
pnpm install          # install all four packages
pnpm -r build         # task build — tsc -b ×3 + `nuxt generate`
pnpm -r test          # task test     — 1334 tests across every package
pnpm -r lint          # task lint     — eslint everywhere
```

Per-package: `pnpm --filter @aktenraum/core test`, `pnpm --filter @aktenraum/api test`, `pnpm --filter @aktenraum/worker test`, `pnpm --filter @aktenraum/web test`.
`pnpm --filter @aktenraum/api typecheck` runs `tsc -p tsconfig.test.json`, which typechecks the test files that `vitest` would otherwise transpile without checking.

Test counts and what they cover:

| Package | Tests | Shape |
| --- | --- | --- |
| `@aktenraum/core` | 219 | pure functions — normalisers, chunker, models, the Paperless client against a fake fetch |
| `@aktenraum/api` | 615 | real Nest app over **pg-mem** + a stateful fake Paperless, driven with supertest |
| `@aktenraum/worker` | 179 | routing matrix, queue semantics, prompt assembly, synthesizers, plus extraction/propagation/indexing flows against an in-memory fake Paperless |
| `@aktenraum/web` | 321 | vitest + `@nuxt/test-utils` (`environment: "nuxt"`, `mountSuspended`, `mockNuxtImport`) |

After a code change: `task build` rebuilds all three images. Every Dockerfile's build context is the repo root, so an edit in `packages/aktenraum-core/src/` is picked up by rebuilding either service.

For an inner loop without rebuilds, the dev overlay (`docker compose --project-directory docker -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up -d aktenraum-api auto-tagger`) bind-mounts `src/` into both services and runs `tsx watch` — a `.ts` save restarts the process in about a second. `docker compose --project-directory docker up -d aktenraum-api auto-tagger` restores the prod entrypoints.

The Nuxt dev server (`task web:dev`) serves on `:4300` and proxies `/api` to the nginx edge on `:8080` (`nitro.devProxy` in `apps/web/nuxt.config.ts`). Production deploys bake the SPA into the nginx image in a multi-stage build — no Node needed at deploy time.

**End-to-end**: `bash scripts/e2e-worker.sh` runs the whole pipeline against a throwaway Paperless/Postgres/Qdrant stack. It never touches the live stack and refuses to start on live-stack ports.

CI (`.github/workflows/ci.yml`) has two jobs: `ci` (`pnpm install --frozen-lockfile` → lint → build → api + web typecheck → test) and `images` (validate the main and dev compose files, build all four images, `nginx -t` inside the built nginx image). The worker e2e (`scripts/e2e-worker.sh`) is NOT in CI — it needs a local Ollama with the 14B model; run it before merging pipeline changes.

---

