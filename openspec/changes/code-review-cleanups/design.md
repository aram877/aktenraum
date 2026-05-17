## Context

Five review items, grouped here because they share a goal (tighten the localhost baseline) and a release window. Three touch infrastructure (image pins, HF cache volume), one is a small cross-service code change (approve → propagation trigger), and two are documentation-only (ADR, eval scaffold). The non-trivial design questions live in two places: the propagation trigger (auth, failure mode, deduplication against the existing poller) and the HF cache (mount path, env-var contract). The rest are mechanical.

Current state, for grounding:
- `services/auto-tagger/src/auto_tagger/main.py` runs `process_approved_document` inline inside a 30-second poller — there is no queue between the poller and the propagator today, unlike the extraction path which is queue+worker.
- `services/aktenraum-api/src/aktenraum_api/inbox/service.py` already swaps the lifecycle tag through `gateway.swap_lifecycle_tag` and returns the updated `InboxDetail`. It does not call out to the auto-tagger anywhere.
- `services/aktenraum-api/src/aktenraum_api/documents/router.py:525` is the existing precedent for "best-effort POST to `${auto_tagger_url}/trigger/extract` with the secret header" — same pattern, copied for propagate.
- `services/aktenraum-api/src/aktenraum_api/main.py:89-100` already kicks off a background `_warm_reranker()` task during lifespan. The 5-min wait the review flagged was correct at the time the gotcha was written; warm-up landed later. The remaining problem is purely cache persistence across image rebuilds.

## Goals / Non-Goals

**Goals:**
- Approve action feels instant (sub-2-second median end-to-end) without removing the poller safety net.
- `docker compose up -d --build aktenraum-api` does NOT re-download 600 MB.
- All `image:` lines in `docker/docker-compose.yml` reference a specific, reproducible tag (no `:latest`, no major-only `:8`).
- The two-Python-services architecture has a written rationale anyone can read in `docs/adr/`.
- We can answer "does `ai_confidence` predict correctness?" with data, not vibes, within one ad-hoc script run.

**Non-Goals:**
- Removing the propagation poller. It remains as the safety net for missed webhook calls (auto-tagger restart between approve and the poll, network blip, secret mismatch).
- Collapsing auto-tagger into aktenraum-api. The ADR explicitly closes this question for now.
- Changing the `ai_confidence` routing logic, the `AUTO_APPROVE_CONFIDENCE` env var, or any of the lifecycle tags. The eval script is read-only on the corpus.
- Pinning Python or Node dependencies more tightly than current — this change is about external container images only.
- Adding rate limiting or auth-failure backoff — out of scope per review item #7 (localhost-only today).

## Decisions

### 1. Propagation queue + webhook trigger

Mirror the extraction pattern exactly, because divergence has cost:
- A new `asyncio.Queue[int]` is created in `main.py` (`propagation_queue`, capacity matches the extraction queue's bound) and passed into both the webhook server (so `/trigger/propagate` can `put_nowait`) and a new propagation worker task that drains it.
- The existing poller becomes an enqueuer: every 30s it fetches `ai-approved` docs and `put_nowait`s their ids onto the same queue, with a "skip if already in queue" guard (cheap dict in `ProcessingState`).
- Webhook handler is structurally identical to `trigger_extraction`: same secret check via `hmac.compare_digest`, same JSON shape (`{"document_id": <int>}`), same 202/400/401/503 responses. Factored shared bits into a small `_enqueue_or_503` helper to avoid copy-paste.

Alternatives considered:
- **Call `process_approved_document` directly from the webhook handler.** Rejected: it would let a slow propagation call back-pressure the HTTP listener and complicate `ProcessingState` (which currently assumes one inline propagation slot owned by the poller loop). Queue + worker is the pattern we already use for extraction; consistency beats ~30 lines of saved code.
- **Reuse the extraction queue.** Rejected: the extraction worker calls `process_document`, not `process_approved_document`. Mixing them would mean a dispatch in the worker that inspects tags before running. Cheaper to keep two queues than to encode the dispatch.
- **Drop the poller entirely once the webhook works.** Rejected as risk/reward unfavourable: the poller is the only thing that catches an `ai-approved` doc if the auto-tagger was restarting at approve time. Keeping it costs one Paperless GET every 30s.

### 2. aktenraum-api approve endpoint: fire-and-forget, never raise

Reuse `_ping_auto_tagger` pattern from `documents/router.py:525` and call it from `inbox/service.py::approve` AFTER `swap_lifecycle_tag` returns successfully (not before — we don't want a stale trigger if the tag swap fails on a 409 conflict). The trigger call uses `asyncio.wait_for(timeout=2.0)` and catches every exception, logging at `warning` level with `doc_id` + `error`. Tag swap is the source of truth; the trigger is an optimization.

Alternatives considered:
- **Block on the trigger response.** Rejected: a 2-second hang per approve is exactly the UX bug we're fixing.
- **Use `asyncio.create_task` and never await.** Rejected for FastAPI lifecycle reasons — a fire-and-forget task created in a request handler can leak across worker restarts; the bounded `wait_for` is cheap and prevents that.

### 3. HuggingFace cache as a named Docker volume

Mount `aktenraum-hf-cache` at `/root/.cache/huggingface` (since the aktenraum-api Dockerfile runs as root today — verify before merge). Set `HF_HOME=/root/.cache/huggingface` and `HUGGINGFACE_HUB_CACHE=/root/.cache/huggingface/hub` explicitly in the compose `environment:` block so the path stays constant if the Dockerfile changes USER. The lifespan warm-up code is unchanged — it already calls `reranker._ensure_loaded()` in the background, which uses whatever HF cache the env says.

Alternatives considered:
- **Bake the model into the Docker image.** Rejected: 600 MB image bloat for a model that already lives in the volume after the first run; also makes the model a build-time constant when we may want to swap to `bge-reranker-base` (~330 MB) on smaller hosts via env.
- **Bind-mount a host path.** Rejected: named volume is portable across Docker hosts, owned by Docker (no host permission games), and survives `docker compose down`. Bind-mount is the right choice for evals (the YAML must be host-editable); the model cache has no such need.

### 4. Image pins

- `apache/tika` → `apache/tika:2.9.2.1-full` (current latest stable on Docker Hub at writing). `-full` matches the upstream Paperless recommendation for full-format support.
- `gotenberg/gotenberg:8` → `gotenberg/gotenberg:8.13.0`. Paperless docs validate against 8.x; 8.13.0 is current stable.
- `ghcr.io/paperless-ngx/paperless-ngx:latest` → `ghcr.io/paperless-ngx/paperless-ngx:2.18.4` (the current installed version; verified via `docker compose exec paperless cat /version` before merge). Pin to the same version that's already deployed so we don't trigger an unintended upgrade as part of a cleanup change.

Alternatives considered:
- **Pin by digest (`@sha256:...`).** More reproducible but uglier in YAML; for a personal stack the tag pin is the right cost/value trade-off. Document the upgrade path: "to bump, change the tag, run `task tagger:rebuild` (or equivalent), and update the ADR if behavior changes."
- **Pin everything to digests including postgres/redis.** Out of scope; Postgres-15 and Redis-7 are major-version pins which is the right granularity for stable upstreams.

### 5. ADR for two Python services

Format: copy `docs/adr/000-template.md`. Status: Accepted. Decision summary: keep the split. Rationale: process isolation (5 long-lived async tasks + 600 MB sentence-transformers RSS in auto-tagger; FastAPI request loop in aktenraum-api), independent Docker memory limits, independent restart cadence. Acknowledged costs: env duplication (PAPERLESS_API_TOKEN, WEBHOOK_SECRET, LLM_BACKEND), one network hop on the `/trigger/*` calls. Re-evaluate when either (a) RSS pressure on a single host forces collapse, or (b) a third Python service appears (the two-service threshold becomes harder to defend at three).

### 6. Confidence eval script

Lives at `scripts/eval-confidence-correlation.py`, runs from the host (NOT in a container — it just needs `requests` + a Paperless token). Inputs: env vars `PAPERLESS_BASE_URL` + `PAPERLESS_API_TOKEN`. Walks every doc with `ai-propagated`, reads `ai_confidence` + the current title + the OCR-derived `created_date` vs `ai_issue_date` + a coarse "was the suggested correspondent the one that landed in the native field?" check. Emits one CSV row per doc + a final summary block: count, mean confidence, "approved-unedited" rate by confidence bucket (≤0.5 / 0.5-0.8 / >0.8), Pearson correlation. Exit code 0 regardless. No DB writes, no Paperless writes.

Alternatives considered:
- **A live FastAPI endpoint.** Rejected: this is a one-shot evaluation, not a recurring product feature. A script is appropriate.
- **Backfill an `ai_approved_unedited` boolean and route on it.** Rejected: this proposal explicitly does not change routing. Decide later, after data.

## Risks / Trade-offs

- **[Webhook secret mismatch silently degrades to polling]** → Mitigation: log `propagation_trigger_failed` at warning with the upstream status; CLAUDE.md gets a row noting "if approves feel laggy, check that aktenraum-api's `WEBHOOK_SECRET` matches auto-tagger's".
- **[Both poller and webhook race-enqueue the same doc id]** → Mitigation: propagator already idempotently re-checks lifecycle tags before acting (skips if not still `ai-approved`); the same "skip if processed" guard from the extraction path applies here.
- **[Pinning Paperless to its current version freezes us out of upstream bug fixes]** → Mitigation: the pin captures *known-good* state; future ADR / change can bump it explicitly when the team chooses, with the upgrade path documented (rebuild + smoke-test the gotchas: tag filter, custom-field PATCH, OCR date detection).
- **[HF cache volume grows unbounded if we add more models]** → Mitigation: today only one model lives there. Add a runbook line if/when a second one ships.
- **[Confidence eval reads the entire propagated corpus on each run]** → Mitigation: it's a one-shot human-triggered command; pagination is already a Paperless concern, not ours.

## Migration Plan

Order matters because of the volume / model-warmup interaction:

1. Land the image pins (`docker/docker-compose.yml`) and HF cache volume in one commit. Recreate `aktenraum-api`, `paperless`, `gotenberg`, `tika`. First boot re-downloads the reranker into the volume (one-time ~5 min).
2. Land the auto-tagger `/trigger/propagate` webhook + propagation queue refactor. Build + recreate `auto-tagger`. Verify health endpoint, then poke `curl -X POST http://localhost:8001/trigger/propagate` from inside the network.
3. Land the aktenraum-api approve-fires-trigger change. Rebuild + recreate `aktenraum-api`. Smoke-test: approve a doc in the SPA, watch `docker compose logs auto-tagger` for `propagation_webhook_enqueued` within 1s of click.
4. Land the ADR + the CLAUDE.md edits in one commit. Doc-only; no service touched.
5. Land the eval script + CLAUDE.md TODO row in a final commit. Run the script once locally; record the result in the session note.

Rollback: each commit is independently revertible. The propagation webhook is additive (poller stays). Image pin reverts are mechanical. HF cache volume revert just means the next rebuild re-pays the download.

## Open Questions

- Exact `apache/tika` and `gotenberg/gotenberg` patch tags to pin — verify the latest stable at change-implementation time, not now (one extra `docker image inspect` round-trip per service).
- Whether the Dockerfile runs aktenraum-api as root or a named user — affects the `HF_HOME` mount path. Read the Dockerfile before writing the compose edit.
- Whether the existing `_ping_auto_tagger` helper in `documents/router.py` should move to a shared module (`aktenraum_api/_auto_tagger.py`?) before the inbox path imports it. Lean yes — but resolve in code review, not here.
