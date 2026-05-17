## 1. Image pins and HF cache volume (review item #4 + #6)

- [x] 1.1 Verify the running Paperless version (`docker compose exec paperless cat /usr/src/paperless/src/paperless/version.py` or the about endpoint) and record it for the pin — running 2.20.15
- [x] 1.2 Verify the latest stable tags for `apache/tika` (likely `2.9.2.1-full`) and `gotenberg/gotenberg` (likely `8.13.0`) on Docker Hub before merging — landed on digest pin for tika (tag/version mapping ambiguous) and 8.31.0 for gotenberg (matches the running image label)
- [x] 1.3 Replace `image: apache/tika:latest` (`docker/docker-compose.yml:74`) with the pinned tag — `apache/tika:latest@sha256:2a565f1e…`
- [x] 1.4 Replace `image: gotenberg/gotenberg:8` (`docker/docker-compose.yml:64`) with the pinned tag — `gotenberg/gotenberg:8.31.0@sha256:f0d86e8a…`
- [x] 1.5 Replace `image: ghcr.io/paperless-ngx/paperless-ngx:latest` (`docker/docker-compose.yml:4`) with the verified pin from 1.1 — `2.20.15@sha256:6c86cad8…`
- [x] 1.6 Inspect `services/aktenraum-api/Dockerfile` to confirm the runtime user / `HOME` — runs as `appuser`, `$HOME=/home/appuser`
- [x] 1.7 Add a named volume `aktenraum-hf-cache` to the top-level `volumes:` block in `docker/docker-compose.yml`
- [x] 1.8 Mount `aktenraum-hf-cache` at `/home/appuser/.cache/huggingface`, set `HF_HOME` + `HUGGINGFACE_HUB_CACHE` in `environment:`
- [ ] 1.9 `task api:rebuild`; tail logs and confirm the first start shows `reranker_prewarm_complete` and the second `docker compose up -d --build aktenraum-api` does NOT re-download (look for "Downloading shards" absence) — deferred to task group 7 (validation)
- [x] 1.10 Delete the "bge-reranker-v2-m3 5-minute first-query block" row from CLAUDE.md's gotchas; replace with a one-liner noting the HF cache volume

## 2. Auto-tagger propagation webhook (review item #2 — auto-tagger half)

- [x] 2.1 In `services/auto-tagger/src/auto_tagger/main.py`, add a second `asyncio.Queue[int]` `propagation_queue` with the same bound as `extraction_queue`; pass it into both the HTTP server and a new `propagation_worker` task in `asyncio.gather`
- [x] 2.2 Refactor the existing poller loop in `main.py` so it ENQUEUES `ai-approved` doc ids onto `propagation_queue` rather than calling `process_approved_document` inline; keep the 30s interval, keep `ProcessingState` updates structured the same way
- [x] 2.3 Implement `propagation_worker`: drain the queue forever, per-dequeue re-fetch the document and skip if it no longer carries `ai-approved` (race protection), call `process_approved_document`, update `ProcessingState.propagation` in a try/finally
- [x] 2.4 In `services/auto-tagger/src/auto_tagger/webhook.py`, register `POST /trigger/propagate` mirroring `trigger_extraction`: same secret check via `hmac.compare_digest`, same JSON body shape, same 202/400/401/503 responses; factor shared bits into private helpers (`_check_secret`, `_parse_doc_id`, `_enqueue_or_503`)
- [x] 2.5 Update `make_app` / `run_http_server` signatures in `webhook.py` to accept both queues; thread them through `main.py`
- [x] 2.6 Add `_PROPAGATION_QUEUE_KEY` and register the route; ensure the `processing` GET still reflects propagation slot state
- [x] 2.7 In `services/auto-tagger/tests/test_webhook.py`, add cases mirroring the existing extraction-trigger tests: happy path, missing body, malformed body, wrong/missing secret, queue full
- [ ] 2.8 `task tagger:rebuild`; live smoke test — deferred to validation (task group 7). Local lint + 281-test pytest pass already green.

## 3. aktenraum-api fires the trigger from approve (review item #2 — api half)

- [x] 3.1 Extract `_ping_auto_tagger` into a shared helper at `services/aktenraum-api/src/aktenraum_api/_auto_tagger.py` parametrised by `trigger` (`"extract"` | `"propagate"`) and `timeout`; updated `documents/router.py` to use it for the existing reprocess→extract ping
- [x] 3.2 In `services/aktenraum-api/src/aktenraum_api/inbox/service.py::approve`, after `swap_lifecycle_tag` call the shared helper with `trigger="propagate"`, `timeout=2.0`; relies on the helper's existing swallow-and-log semantics so approve never fails on a flaky auto-tagger
- [x] 3.3 Skip the trigger entirely when `AUTO_TAGGER_URL` is empty (helper returns False without making a request)
- [x] 3.4 `test_inbox_router.py` gains four cases: trigger fires, trigger includes secret header, approve succeeds on 5xx, approve skips trigger when URL is empty
- [ ] 3.5 Rebuild aktenraum-api + live smoke test — deferred to validation (task group 7). 257/257 local aktenraum-api tests pass.

## 4. ADR for the two-Python-services split (review item #1)

- [x] 4.1 Created `docs/adr/004-two-python-services.md` from the template
- [x] 4.2 Status: Accepted. Decision: keep the split. Process-isolation rationale captured in detail.
- [x] 4.3 Costs section: env duplication, in-cluster HTTP hop, two health endpoints — all explicitly listed
- [x] 4.4 Four revisit triggers documented (third Python service, single-host RSS pressure, shared-model handle, latency-load-bearing trigger calls)
- [x] 4.5 Linked from top of CLAUDE.md "Stack" section. `docs/architecture.md` exists — leaving a follow-up to thread the link there in the architecture doc's natural pass.

## 5. Confidence-vs-correctness eval scaffold (review item #3)

- [x] 5.1 Created `scripts/eval-confidence-correlation.py` — env-var-driven (`PAPERLESS_BASE_URL`, `PAPERLESS_API_TOKEN`), stdlib-only (no extra deps), paginates `/api/documents/?tags__id__all=<ai-propagated-id>`, joins `ai_confidence` against the correspondent-match + doctype-match proxy
- [x] 5.2 CSV to stdout (or `--out`); stderr aggregate block (count, mean, bucket rates, Pearson)
- [x] 5.3 CLAUDE.md row added — references the script and the N≥50 / Pearson<~0.3 decision criterion
- [x] 5.4 Ran locally against the live stack — n=19 docs, mean confidence 0.978, all in "high" bucket, Pearson essentially zero (predictor has no variance). Captured in CLAUDE.md.

## 6. Documentation cadence

- [x] 6.1 Updated `docs/plans/desktop-app.md` Phase 0.3 — removed the (incorrect) `ollama pull bge-reranker-v2-m3` line, documented why the reranker lives in the HF cache volume instead
- [x] 6.2 New CLAUDE.md gotcha row: "Approve action feels laggy" → check `WEBHOOK_SECRET` parity, document fallback to 30s poller on 401
- [x] 6.3 Session note appended to `docs/sessions/2026-05-17.md` — five items, eval result data, follow-ups

## 7. Validation

- [x] 7.1 Python full pass: 538/538 pytest, ruff clean. SPA lint: 2 pre-existing warnings unrelated to this change.
- [x] 7.2 Live trigger smoke test from inside the compose network: `POST /trigger/propagate` returns `{"queued": <id>}` with the matching `X-Aktenraum-Secret`, 401 without it. End-to-end approve→propagate timing left for manual user verification with a real `ai-pending` doc.
- [x] 7.3 Recreated `aktenraum-api` with the HF cache volume. First start hit a `PermissionError` (root-owned mount on appuser-owned process) — fixed in Dockerfile (`mkdir -p /home/appuser/.cache/huggingface && chown -R appuser:appuser /home/appuser/.cache` before `USER appuser`), wiped the volume, rebuilt. Second start: model is downloading into the volume (193 MB landed of ~600 MB at confirmation time). Future rebuilds will skip the download because the volume persists.
- [x] 7.4 `openspec status` reports all 4 artifacts complete. Archive deferred per project's `aktenraum-commit-discipline` — the human verifies the approve→propagate UX timing on a real doc before commit/archive.
