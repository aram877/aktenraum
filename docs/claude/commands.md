# Commands: task runner, raw docker, logs

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

### Task runner

The root `Taskfile.yml` ([Taskfile.dev](https://taskfile.dev), `brew install go-task`) wraps every common workflow. `task --list` enumerates them. Use these shortcuts in preference to raw commands so future sessions stay consistent:

| Task | What it does |
| --- | --- |
| `task start` / `task stop` / `task status` | bring the stack up (also recreates any service whose `docker/.env` values changed), take it down (data preserved), see what is running |
| `task logs SVC=auto-tagger` | tail one service; omit `SVC` for all of them |
| `task build` | rebuild every image (incl. backup) and restart what changed; `--remove-orphans` drops containers of retired services |
| `task web:dev` | Nuxt dev server on `:4300`, proxying `/api` to the nginx edge on `:8080` (`nitro.devProxy` in `apps/web/nuxt.config.ts`) |
| `task test` / `task lint` | vitest and eslint across all four packages (runs `pnpm install` first). One package: `pnpm --filter @aktenraum/api test` |
| `task setup` | one-command install on a new machine (`scripts/first-run.sh`): prerequisite checks → `docker/.env` → asks for `AKTENRAUM_DATA_DIR` (default `~/aktenraum`, Windows `%USERPROFILE%/aktenraum`) → secrets → data folders → pulls the Ollama models → build + start → token → Paperless fields → waits for health → backup init + first snapshot + restore check → prints the login. Idempotent; never use it to upgrade a running install |
| `task login` | explains passkey sign-in (there is no aktenraum password any more) |
| `task setup-link USER=<name>` | print a single-use setup link (30 min) to create a passkey — first run, or a member locked out (`scripts/setup-link.sh` → `node dist/auth/setup-link-cli.js` in the api container; stdout = the link only) |
| `task recover` | re-mint the Paperless API token + restart both Node services (fixes 401 storms after any DB recreation) |
| `task destroy` | stop the stack and delete `AKTENRAUM_DATA_DIR` entirely (prompts for `DELETE`) |
| `task rag:reembed` | drop the Qdrant collection and re-embed everything (run after an embedding-model/dimension change; prompts first) |
| `task backup:verify` | non-destructive DR rehearsal: `restic check` + restore to staging + validate both DB dumps |

Without a task (from repo root; `DC` = `docker compose --project-directory docker`):

| Need | Raw command |
| --- | --- |
| Hot-reload both Node services (`tsx watch`, a `.ts` save reloads in ~1s) / back to prod | `DC -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up -d aktenraum-api auto-tagger` / `DC up -d aktenraum-api auto-tagger` |
| Worker e2e against a **throwaway** stack (`docker/docker-compose.e2e.yml`, project `aktenraum-e2e`, ports 8100/8101/8102/6433; refuses live-stack ports; its api writes to the e2e Qdrant with `RERANKER_ENABLED=false`, so share / removal / trash payloads are asserted directly) / tear it down | `bash scripts/e2e-worker.sh` / `bash scripts/e2e-worker.sh --down` |
| Index the existing corpus into Qdrant / score retrieval against `evals/golden-questions.yaml` | `bash scripts/backfill-rag-index.sh` / `bash scripts/run-rag-eval.sh` |
| Tenancy migration (one-off, ADR-009; `node dist/tenancy/migrate.js` in the api): plan / real run (refuses unless the backup status says healthy and the newest complete snapshot is < 2 h old; exit 3) | `bash scripts/migrate-tenancy.sh --dry-run` / `bash scripts/migrate-tenancy.sh` (`--i-have-a-backup` overrides the gate) |
| Manual backup snapshot / list snapshots / integrity check | `DC exec backup /usr/local/bin/entrypoint.sh` / `DC exec -e RESTIC_REPOSITORY=/repo backup restic snapshots --tag aktenraum` / `DC exec -e RESTIC_REPOSITORY=/repo backup restic check --read-data-subset=5%` (Git Bash: prefix `MSYS_NO_PATHCONV=1`, use `//usr/...`) |
| psql shell / one-shot query | `DC exec postgres psql -U paperless -d aktenraum` / `DC exec postgres psql -U paperless -d aktenraum -c "…"` |
| Re-extract one document | "Erneut verarbeiten" in the SPA, or the `{"tags": []}` PATCH in the Paperless quick reference below |
| Paperless AI fields + lifecycle tags (idempotent; part of `task setup`) | `bash scripts/bootstrap-paperless.sh` |
| Qdrant collection info | `curl -s -H "api-key: $(grep ^QDRANT_API_KEY= docker/.env \| cut -d= -f2)" http://localhost:6333/collections/aktenraum_chunks` (dashboard at `/dashboard` asks for the same key) |
| Expose on the tailnet / show mappings | `tailscale serve --bg --https=443 http://localhost:8080` / `tailscale serve status` |

### Start / stop (raw)

```bash
cd docker
docker compose up -d          # start all                 (task start)
docker compose down           # stop all (data preserved) (task stop)
docker compose up -d --build auto-tagger   # rebuild after code changes (task build)
docker compose up -d --build backup        # rebuild after backup changes
```

### Logs (raw)

```bash
docker compose logs -f auto-tagger        # task logs SVC=auto-tagger
docker compose logs -f backup
docker compose logs --tail=50 paperless
```

---

