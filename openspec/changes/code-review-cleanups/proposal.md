## Why

A recent code review surfaced five concrete issues against the current localhost stack: a polling-only approve→propagate path that adds up to 30s of perceived lag to every "Approve" click; a HuggingFace reranker cache that vanishes on every image rebuild (so the 5-minute first-load tax keeps recurring); three Docker images pinned to floating tags (`:latest`, `:8`); a two-Python-services architecture nobody has codified in an ADR; and an `ai_confidence`-driven auto-approve path nobody has measured against ground truth. None of them are crises — each is a small, isolated cleanup. Bundling them is the right unit of work because they all share the same goal (tighten the localhost baseline before the next feature phase) and none individually justify a dedicated change.

## What Changes

- **Approve fires propagation immediately** (review item #2). `POST /api/inbox/{id}/approve` swaps the lifecycle tag as today, then best-effort-POSTs to a new `auto-tagger` webhook `POST /trigger/propagate` (mirroring the existing `/trigger/extract` pattern, same `WEBHOOK_SECRET` auth). The auto-tagger's propagation worker drains a new `asyncio.Queue[int]` shared between the webhook and the existing 30-second poller; the poller stays as the safety net for missed webhook calls. Result: approve → fully-propagated typically <2s instead of up to 30s.
- **HuggingFace model cache persists across rebuilds** (review item #6, scoped down). A named Docker volume `aktenraum-hf-cache` mounts at `/home/app/.cache/huggingface` (or wherever the non-root user's HOME resolves) inside `aktenraum-api`; `HF_HOME` / `HUGGINGFACE_HUB_CACHE` are set explicitly so `sentence-transformers` lands there. The lifespan-level background warm-up already exists (`main.py:89`) — this just stops re-paying the 600 MB download on every `docker compose up -d --build aktenraum-api`. The stale "5-minute first `/ask` block" gotcha in CLAUDE.md and the desktop-app plan gets retired in the same commit.
- **Floating image tags pinned to specific versions** (review item #4). `apache/tika:latest` → `apache/tika:2.9.2.1-full`; `gotenberg/gotenberg:8` → `gotenberg/gotenberg:8.13.0`; `ghcr.io/paperless-ngx/paperless-ngx:latest` → the latest stable tagged release at change time (e.g. `2.18.4`). Pin Qdrant alongside (already `v1.17.1`, leave as-is; document the policy). One line per change in `docker/docker-compose.yml`.
- **ADR codifying the two-Python-services split** (review item #1). New `docs/adr/004-two-python-services.md` documenting the deliberate choice: process isolation (auto-tagger runs five long-lived asyncio tasks + 600 MB sentence-transformers RSS; aktenraum-api owns the FastAPI request loop), independent memory caps in Docker, independent restart cadence (prompt tweaks don't drop HTTP sessions). Acknowledges the costs (env duplication, network hop for the trigger webhook, two health endpoints). Lists the trigger to revisit (if RSS pressure forces collapse, OR if a third Python service appears). No code change.
- **Confidence-vs-correctness eval scaffold** (review item #3). New script `scripts/eval-confidence-correlation.py` that joins `ai_confidence` against "approved-unedited" vs "approved-with-edits" vs "rejected" across the existing `ai-propagated` corpus, emitting a CSV + a one-line summary (Pearson + count). Auto-approve routing stays UNTOUCHED — this change ships measurement only. A `TODO` in CLAUDE.md (under "What's implemented vs planned") references the script and the decision criterion (re-evaluate auto-approve once N≥50 reviewed docs exist).

## Capabilities

### New Capabilities
None — every change extends an existing service or adds documentation. The confidence-eval script is operational tooling, not a user-facing capability.

### Modified Capabilities
- `auto-tagger`: new requirement — propagation MUST be triggerable via authenticated HTTP webhook in addition to the existing poller.
- `aktenraum-api`: modified requirement — the inbox approve endpoint MUST fire a best-effort propagation trigger to auto-tagger immediately after the lifecycle-tag swap; failure of the trigger MUST NOT fail the approve call (the safety-net poller still catches the doc).

## Impact

- **Code**:
  - `services/auto-tagger/src/auto_tagger/webhook.py` — register `POST /trigger/propagate`, enqueue to a new propagation queue.
  - `services/auto-tagger/src/auto_tagger/main.py` — create the propagation queue; rework the propagation loop into a worker that drains the queue (webhook path) AND a poller that re-enqueues missed `ai-approved` docs every 30s (safety net).
  - `services/aktenraum-api/src/aktenraum_api/inbox/service.py` — after `swap_lifecycle_tag`, fire-and-forget POST to `${AUTO_TAGGER_URL}/trigger/propagate` with the `X-Aktenraum-Secret` header when `WEBHOOK_SECRET` is set; log on failure but never raise.
  - `docker/docker-compose.yml` — pin three image tags; add `aktenraum-hf-cache` named volume to `aktenraum-api`; set `HF_HOME` env.
- **Docs**:
  - `docs/adr/004-two-python-services.md` (new).
  - `CLAUDE.md` — retire the "5-min first /ask" gotcha row; add a one-line note that approve triggers propagation immediately (poller stays as safety net); add the confidence-eval TODO under "What's implemented vs planned".
  - `docs/plans/desktop-app.md` — drop the now-superseded reranker pre-pull line from Phase 0.3 (Ollama can't pull this model; the cache volume covers it).
- **Tests**:
  - `services/auto-tagger/tests/test_webhook.py` — new cases for `/trigger/propagate` (happy path, missing body, bad secret, queue full).
  - `services/aktenraum-api/tests/inbox/test_service.py` — new case asserting approve fires the trigger; new case asserting approve still succeeds when the trigger errors / times out.
- **Operational**:
  - One-time HF cache volume backfill is implicit: first restart re-downloads (~5 min) then persists.
  - Buyer / new-clone first-run experience improves (image digests known-good; no surprise behavior change on pulls).
- **Out of scope**:
  - Rate limiting (review item #7) — deferred until the app exposes beyond localhost.
  - Collapsing the two Python services into one (review item #1's alternative) — explicitly rejected in the ADR.
  - Monorepo restructuring (review item #5) — explicitly noted as a future-only concern.
