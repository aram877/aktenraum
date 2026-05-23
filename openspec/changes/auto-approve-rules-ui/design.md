## Context

Auto-approve routing today lives in `services/auto-tagger/src/auto_tagger/tagger.py::_route_lifecycle_tags`. It reads two values off the `Settings` Pydantic class:

- `auto_approve_confidence: float` — single global threshold.
- `auto_approve_types: list[str]` — comma-separated allowlist of `DocumentType` values; empty disables auto-approve entirely.

Both come from `docker/auto-tagger.env`. They are baked into the worker process at startup; changes require `docker compose up -d --build auto-tagger` (per CLAUDE.md, `restart` alone doesn't re-read env files — a documented gotcha). The routing function is synchronous and runs inside the per-doc extraction worker after a successful LLM call. Its output is one of three tag combinations: `[ai-approved]` (auto-approve), `[ai-pending]` (review), or `[ai-pending, ai-low-confidence]` (review with low-confidence badge).

What this change must NOT break:

- The lifecycle-tag state machine (`packages/aktenraum-core/src/aktenraum_core/paperless/client.py::LIFECYCLE_TAGS`). The routing decision can only emit the same three combinations as today.
- The auto-tagger's per-doc fault boundary. If the rule-store lookup fails, the worker must still produce a routing decision; it cannot block extraction.
- The webhook + poller race protection. Adding async I/O inside `_route_lifecycle_tags` changes its call signature but not its position in the pipeline — it still runs once per extraction, post-LLM, pre-PATCH.
- The auto-tagger Dockerfile build context (repo root, see CLAUDE.md) — new dependencies land in `services/auto-tagger/pyproject.toml`, no Dockerfile changes needed.

Existing precedent for cross-service HTTP inside the auto-tagger:
- The auto-tagger already runs an HTTP server (`aiohttp` on port 8001) for `/trigger/extract` and `/trigger/propagate`. It does NOT currently make outbound HTTP calls — except for Paperless API, Ollama, and (for RAG indexing) Qdrant. Adding aktenraum-api as a fourth outbound HTTP target is a new edge in the service graph but a small one.

Existing precedent for the `WEBHOOK_SECRET` shared secret:
- `WEBHOOK_SECRET` is set in both `docker/.env` (passed to paperless's `post_consume.sh`) AND `docker/auto-tagger.env` (validated by the aiohttp webhook). `bootstrap-secrets.sh` reconciles them automatically. This change adds a third consumer: aktenraum-api's `/api/internal/auto-approve-rules` endpoint validates the SAME header against the SAME secret.

## Goals / Non-Goals

**Goals:**
- The maintainer edits auto-approve rules from `/settings` and changes take effect within 60 seconds (one cache-TTL cycle in the auto-tagger), without restarting any container.
- Per-document-type configuration (26 rows) replaces the single global threshold + allowlist, so risk-tolerance can vary per type.
- An attacker who partitions the network between auto-tagger and aktenraum-api cannot accidentally enable auto-approve on types the user has disabled. The auto-tagger fails CLOSED.
- The routing-matrix tests in `test_tagger.py` continue to cover the same matrix (auto-approve / pending / low-confidence) — the test fixtures get a rule store injected instead of env vars.
- An upgrading maintainer who had `AUTO_APPROVE_CONFIDENCE` set sees that value used as the initial `min_confidence` for all 26 seeded rows (preserves their tuning effort), but must re-enable types in the UI (because `enabled=false` is the safer default).

**Non-Goals:**
- Real-time rule propagation (sub-second). 60-second TTL is good enough — rule changes are operator-driven and rare.
- A separate audit-log table. `updated_by` + `updated_at` on the row capture the most recent change; that's enough for v1.
- Per-correspondent or per-tag overrides. Doc-type axis only. Future change can add `correspondent_id` nullable column without breaking the v1 schema.
- A dry-run / preview mode ("show me which of my recent docs would have auto-approved under these new rules"). Useful but not blocking; defer.
- Migrating existing `AUTO_APPROVE_TYPES` allowlist entries to `enabled=true` automatically. Empty by default in shipped state; manual re-enable is fine for the rare existing user who had it set.
- Bulk import / export of rules (e.g. for staging→prod migration). Single-install product; manual re-entry is acceptable.

## Decisions

### 1. Storage: new Postgres table in the `aktenraum` DB, not a config file

Three options were considered:

**A. Postgres table in `aktenraum` DB.** The aktenraum-api already manages this DB (users, sessions). Add `auto_approve_rules` table; Alembic migration; SQLAlchemy model.

**B. JSON config file on a shared Docker volume.** Both services mount the same volume, both can read/write. No DB schema. Simple.

**C. Redis hash.** Both services already have network access to redis (paperless's broker). One key per type; TTL not needed (values are persistent).

Picked A. Reasons:
- aktenraum-api already owns DB-backed config (users). Adding a second config table fits the existing seam.
- Concurrent writes are correctly serialised by Postgres transactional semantics — option B (file-based) needs file locking or atomic-rename gymnastics to avoid torn reads on a concurrent edit (which is admittedly unlikely in a single-user product, but adding a file-locking dependency to dodge an edge case is poor cost/benefit).
- Backups already cover Postgres. Option B requires teaching restic about an extra path; option C would need an `appendfsync everysec` policy on a redis instance that's currently treated as ephemeral (paperless's broker).
- Querying / inspecting / scripting against the rule store is trivial with `psql` (vs. parsing JSON or running redis-cli). The maintainer will want to inspect this state during eval work.

The cost of A is one new Alembic migration. That's a small one-time cost.

### 2. Cross-service contract: HTTP, not shared DB

The auto-tagger does not have a database connection today. Adding one would require:
- Adding asyncpg or psycopg to auto-tagger's deps.
- Adding DB connection-string env vars to `docker/auto-tagger.env` (`POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).
- Either duplicating the SQLAlchemy model in auto-tagger OR teaching aktenraum-core about it (the model isn't a "core" concern — it's an API-layer config table — so this would be a misplaced abstraction).
- Reasoning about transactional isolation: the auto-tagger reads the rule store on every extraction; if it reads mid-`PUT` from the SPA, it could see a partially-updated state (Postgres avoids this with row-level locking, but only if you wrap the read in the right isolation level).

HTTP avoids all of that. The auto-tagger calls `GET /api/internal/auto-approve-rules` over the existing Docker network; the response is a stable JSON envelope; aktenraum-api remains the sole writer of the table.

The 60s TTL cache absorbs the latency cost: at most one extra HTTP round-trip per minute per auto-tagger process (and the auto-tagger is a single process).

Alternative considered: push-based update (SPA PUT triggers a webhook to auto-tagger to invalidate its cache). Rejected — adds a second cross-service edge (api → tagger) where we already have one (tagger → api) for the read path. Push-based requires the auto-tagger to be reachable from aktenraum-api (it is, via `auto-tagger:8001`) but also requires the auto-tagger to expose a cache-invalidation endpoint that's secret-gated. The 60s upper bound on staleness is fine in practice — rules don't change minute-by-minute.

### 3. Fail-closed default when the rule store is unreachable

If `aktenraum-api` is down, mid-upgrade, or partitioned, the auto-tagger must still process docs (extraction continues; rules just affect routing). The decision: when the rule HTTP call fails AND the cache is empty (cold start), return a synthetic "all rules disabled" rule set. Result: every doc routes to `ai-pending`, none auto-approve. Logged at WARN level (`auto_approve_rules_unreachable_fail_closed`).

Alternative considered: fail-OPEN by reading the legacy env vars (`AUTO_APPROVE_CONFIDENCE` + `AUTO_APPROVE_TYPES`) if the HTTP fetch fails. Rejected — keeping the env vars as a runtime fallback means two sources of truth, and a confused user who finds auto-approve "magically working" during a partition would have to reason about which path produced the decision. Cleaner to have ONE source of truth and degrade visibly to "everything goes to review" when that source is down.

Alternative considered: fail by halting extraction entirely (refuse to assign any lifecycle tag) until the rule store is reachable. Rejected — extraction is more important than routing precision. The user can always manually approve from the inbox; they cannot manually trigger extraction without the worker running.

The 60s TTL means a brief outage (api restart) is invisible to the worker; only a >60s outage triggers the fail-closed path.

### 4. PUT is full-set replace, not partial upsert

The PUT endpoint accepts `{rules: [...]}` and requires the array to contain exactly 26 entries — one per `DocumentType` enum value. Reasons:

- Eliminates a class of SPA bugs where a buggy form submits 25 rows and silently leaves the 26th at whatever it was before.
- Eliminates the question of "what does it mean to not include a row in the payload?" — does it mean "leave alone" or "delete"? The full-set convention says neither: the payload IS the new state.
- Server validates: 26 entries, no duplicates, every entry's `document_type` ∈ enum, no missing types. Returns 400 with a precise error on any of those.
- The PUT is idempotent at the row level (overwrite `enabled`, `min_confidence`, `updated_at`, `updated_by`) so retries are safe.

Alternative considered: PATCH semantics (send only changed rows). Rejected — opens the "partial state" question; SPA has to track dirty rows; multiple users couldn't safely edit (they could; we have one user, but the convention is worse). Full-set replace is simpler and the payload is small (26 rows × ~50 bytes each = ~1.3 KB).

### 5. Removing env vars vs keeping them as fallback

`AUTO_APPROVE_TYPES` is removed cleanly — the field disappears from the `Settings` Pydantic class, `_split_csv` helper is deleted, the `NoDecode` annotation hack goes away. No runtime fallback. The migration logs a parsed version of the previous value at INFO so the maintainer sees it in the boot log; nothing else uses it after first boot.

`AUTO_APPROVE_CONFIDENCE` is removed as a runtime input but read ONE TIME at migration time: if the env var is set and the table is empty, the migration uses that value as the seed `min_confidence` for all 26 rows. If unset, defaults to `0.90`. The Pydantic `Settings` class drops the field. This preserves the maintainer's prior tuning intent without keeping a hybrid "sometimes env, sometimes table" model after the migration.

Alternative considered: keep both env vars as a runtime override (table values override env, env wins if table is empty). Rejected — see decision #3's rationale. Two sources of truth is worse than one with a clean migration.

### 6. UI: 26-row table, full-set save, no per-row save buttons

The Settings section renders all 26 rules in one table. The user edits any subset, hits a single Save button at the bottom. Save invokes a PUT with the full set (all 26 rows, including unchanged ones).

Alternative considered: per-row inline save (each row has its own Save / Cancel). Rejected — the UX gets noisy (26 little save buttons), the API would need a PATCH endpoint AND the full-set PUT, and the user would lose the "see all my changes in one summary before committing" affordance. Single-save is more obviously safe.

A Reset button discards unsaved edits by re-fetching from the server. The "Aktueller Wert" hint per row shows the server-side value so the user can see at a glance what they've drifted from.

### 7. 60s TTL — why not shorter or longer?

60 seconds is a balance. Shorter (e.g. 10s) means rule changes propagate faster but every extraction in a busy minute would still hit at most 6 HTTP calls (cheap, but the TTL is per-process not per-call — so actually still just 6 per minute for the worker). Longer (e.g. 5 min) reduces HTTP traffic to ~zero but means the user has to wait up to 5 minutes after Save to see the effect.

60s is "user pulls down the docs they want to test, hits Save, takes 2-3 minutes to reupload a test doc, by the time the doc gets to routing the new rules are live." That's the workflow.

Cache TTL is per-process: the auto-tagger is a single process, so one TTL value covers the whole system. No distributed cache invalidation problem to solve.

### 8. Security: reuse `WEBHOOK_SECRET` for the internal endpoint

The auto-tagger and aktenraum-api already share `WEBHOOK_SECRET` via `bootstrap-secrets.sh` reconciliation. The new `GET /api/internal/auto-approve-rules` endpoint requires the SAME `X-Aktenraum-Secret` header. Reasons:
- No new secret to manage.
- Same threat model (only services on the Docker network or holding the secret can call internal endpoints).
- Bootstrap automation already covers it.

When `WEBHOOK_SECRET` is empty on both sides (the "secret disabled" mode used in dev), the endpoint accepts unauthenticated calls — consistent with how the auto-tagger's `/trigger/extract` already behaves in that mode.

## Risks / Trade-offs

- **[60s TTL hides a typo for 60s]** A maintainer who lowers `min_confidence` on `Ausweis` from 0.95 to 0.05 by accident has up to 60 seconds before the auto-tagger picks up the change and starts auto-approving ID cards at low confidence. → Mitigation: the Pydantic `min_confidence` validator on PUT requires the value to be in `[0.00, 1.00]` AND warns (via 200-with-warning header — actually no, we'll just rely on the SPA UI showing a confirmation prompt for values < 0.50) if the value seems unreasonably low. The SPA shows a yellow "Achtung: niedriger Schwellwert" indicator for any row where the user has dropped `min_confidence` below 0.70 on save — visible-by-design, not a hard block.

- **[HTTP dependency between auto-tagger and aktenraum-api]** Adding a new edge in the service graph means the auto-tagger now soft-depends on aktenraum-api at startup. → Mitigation: fail-closed default (decision #3) means a partition doesn't break extraction, just disables auto-approve. `docker-compose.yml` adds `aktenraum-api` to auto-tagger's `depends_on` so the startup order is sensible, but `depends_on` without `condition: service_healthy` doesn't block forever — the auto-tagger boots even if aktenraum-api is still warming up.

- **[Migration of legacy env vars is one-shot — no rollback]** Removing `AUTO_APPROVE_TYPES` and `AUTO_APPROVE_CONFIDENCE` from `Settings` is a hard cut. If the maintainer rolls back the auto-tagger image to a pre-change version, the old code reads the env vars from `auto-tagger.env` — which may now contain a `AKTENRAUM_API_URL` line they don't recognise (harmless; ignored). → Mitigation: the change ships in a release that updates both `aktenraum-api` and `auto-tagger` images at the same `docker compose up -d --build`. Rollback is to pin both images to the previous tag. Documented in the session note.

- **[Single-source-of-truth means losing the rule store is more impactful than losing the env vars was]** With env vars, the maintainer could SSH in, edit a file, recreate the container, and have rules. With the table, an unrecoverable Postgres corruption means re-seeding from the migration default (`enabled=false` everywhere). → Mitigation: the table is included in restic backups (Postgres dumps already cover it); recovery is the same path as recovering users/sessions. The fail-closed default during recovery is also the safe default — the maintainer can verify the restored rules in the UI before re-enabling anything.

- **[Auto-tagger cache hides server-side bugs for 60s]** If aktenraum-api ships a bug that returns malformed payloads, the auto-tagger's cache mitigates blast radius — but only if it had a good payload cached first. Cold start during a bad-deploy lands directly on the fail-closed path. → Mitigation: the auto-tagger validates the payload via the same `AutoApproveRule` Pydantic model that aktenraum-api uses (model lives in `aktenraum-core` so both services share it). Malformed payload → ValidationError → fail-closed.

- **[`updated_by` is informational, not authoritative]** Single-user product means `updated_by` will always be the maintainer; the field exists for future multi-user growth but is not a security gate. → Mitigation: documented as informational. Anyone with an authenticated session can edit any rule; there's no per-row ACL.

## Migration Plan

The change is a single deploy because both services rebuild together.

1. Maintainer pulls the new repo state and runs `task tagger:rebuild api:rebuild` (or `docker compose up -d --build auto-tagger aktenraum-api`).
2. `aktenraum-api` boots; the container entrypoint runs `alembic upgrade head` which:
   - Creates the `auto_approve_rules` table.
   - Reads `AUTO_APPROVE_CONFIDENCE` from the environment if present (passed through the compose env or `docker/aktenraum-api.env`). Defaults to `0.90` if unset.
   - Inserts 26 rows, one per `DocumentType`, all with `enabled=false` and the resolved `min_confidence`.
   - Logs `legacy_auto_approve_env_observed` at INFO with the parsed value of `AUTO_APPROVE_TYPES` (if set), for the maintainer's visibility — does NOT auto-enable those types.
3. `auto-tagger` boots; the new code reads `AKTENRAUM_API_URL` from env (defaults to `http://aktenraum-api:8002`). First extraction triggers a rule fetch; subsequent extractions hit the cache.
4. Maintainer opens `/settings → Auto-Genehmigung`, reviews the 26 rows (all disabled), enables the desired types, hits Save. Within 60 seconds the auto-tagger sees the change.

Rollback: re-deploy the previous image tags for both services. The Alembic downgrade is `DROP TABLE auto_approve_rules` (the table has no FK references). The env vars in `docker/auto-tagger.env` for the previous version need to be restored manually if they were removed. Documented in the rollback paragraph of the session note.

The lifespan reconciler in aktenraum-api runs on EVERY startup and inserts any missing `DocumentType` rows (insert-if-not-exists, never delete). Adding a 27th `DocumentType` to the enum in a future change requires no migration — the reconciler picks it up automatically on next boot.

## Open Questions

None at proposal time. Decisions above lock in:
- 60s TTL (decision #7)
- All-disabled / 0.90 seed default (decision #5)
- Full-set PUT semantics (decision #4)
- HTTP not shared-DB (decision #2)
- Fail-closed default (decision #3)

If maintainer feedback during apply surfaces a question (e.g. "I want pre-enabled defaults for Rechnung + Kontoauszug"), it gets resolved in tasks.md rather than re-opening the design.
