# Auto-tagger behaviour, lifecycle, routing, taxonomy

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

## Auto-tagger behaviour

The service runs five concurrent loops from `loops.ts`, orchestrated by `main.ts`, sharing `AsyncQueue` instances for extraction and propagation (doc ids) and indexing (`IndexJob` = `{kind: "full" | "metadata", docId}`):

```
                        Paperless's post_consume_script
                                      ↓
                          POST /trigger/extract
                                      ↓
   poller ─────────► AsyncQueue<number> ◄────── webhook handler
   (every 30s,                |
   safety net)                ▼
                       extraction worker
                       (drains queue,
                       per-doc fault boundary)
                                      ↓
                          process_document → tag

   propagation loop (every 30s, polls for ai-approved → native fields)
```

### Lifecycle tags (8 total — 6 lifecycle + 2 auxiliary)

| Tag                    | Meaning                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ai-pending`           | Extracted, awaiting human review                                                                                        |
| `ai-approved`          | User approved → propagation watcher will copy to native fields                                                          |
| `ai-rejected`          | User rejected → no propagation, no retry                                                                                |
| `ai-propagated`        | Native correspondent/document_type/tags written; final success state                                                    |
| `ai-propagation-error` | Propagation failed mid-run; manual intervention needed                                                                  |
| `ai-error`             | Extraction failed (LLM error, schema validation, etc.); manual retry by clearing tags                                   |
| `ai-auto-approved`     | Auxiliary flag (not a lifecycle state); set alongside `ai-approved` when both gates pass (rule.enabled=true AND confidence ≥ rule.min_confidence for the doc's type, per the `auto_approve_rules` table). The SPA renders an "Auto-genehmigt" badge from this tag. Persists through propagation. |
| `ai-low-confidence`    | Auxiliary flag (not a lifecycle state); coexists with `ai-pending` to surface uncertain extractions in the review queue |

The auto-tagger's poller excludes the six lifecycle tags from its scan; the worker re-checks on dequeue and skips with `skip_already_processed` if any lifecycle tag is set (handles webhook+poller race).

### Extraction (worker + poller + webhook)

- **Webhook** (`POST /trigger/extract`, port 8001 internal-only): paperless's `post_consume_script` POSTs the doc id with `Authorization: Bearer $AKTENRAUM_HOOK_TOKEN`; auto-tagger enqueues and logs `webhook_enqueued … caller=paperless-hook`. The hook token opens nothing else (403); a missing/unknown credential is 401 and the poller picks the doc up.
- **Poller** (`POLL_INTERVAL_SECONDS`, default 30s): scans for docs without lifecycle tags and enqueues. Safety net for missed webhooks.
- **Worker**: drains queue. Per-doc steps:
  1. Re-fetch by id; skip if any lifecycle tag (race protection)
  2. Build prompt: base SYSTEM_PROMPT + (optional) per-correspondent history hint + (optional) few-shot exemplars from propagated corpus
  3. Call configured LLM backend; validate via zod
  4. PATCH 12 `ai_*` custom fields (with monetary, date, string normalisers at boundary)
  5. Apply lifecycle tag(s) per routing rules (single PATCH)
  6. Non-`Sonstiges` docs: second LLM pass extracts the type's `TYPE_FIELD_SCHEMA` fields and PATCHes the non-empty ones to `/api/documents/{id}/type-fields` (`auto-tagger/src/type-fields.ts`, non-fatal: `type_specific_pass_done` / `_failed`). Dropped in the Node port and restored 2026-10-01 — docs extracted between the cutover and then have no type fields until reprocessed.

### Confidence-based routing (`routing.routeLifecycleTags`)

Per-`DocumentType` rules live in the aktenraum-api `auto_approve_rules` table (one row per enum value, 27 total), edited from `/settings → Auto-Genehmigung` in the SPA. The auto-tagger fetches them over HTTP (`GET /api/settings/active-auto-approve-rules`, worker credential `SVC_TOKEN_WORKER`) with a 60-second in-process TTL cache (`auto-tagger/src/auto-approve-config.ts`).

| Condition                                                                        | Tag(s) applied                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rule.enabled` AND `confidence ≥ rule.min_confidence` for the doc's type         | `["ai-approved", "ai-auto-approved"]` (skips review; propagation fires)   |
| `rule.enabled = false` for the doc's type                                        | `["ai-pending"]` with `reason="type_disabled"`                            |
| `rule.enabled` AND `confidence < rule.min_confidence`                            | `["ai-pending"]` with `reason="confidence_below_min"`                     |
| Rule store unreachable at cold start (api down before auto-tagger boot)          | `["ai-pending"]` with `reason="rules_unreachable_fail_closed"`            |
| Additionally if `confidence < LOW_CONFIDENCE_THRESHOLD` (and not auto-approving) | appends `ai-low-confidence` to whichever pending branch above             |

The legacy `AUTO_APPROVE_TYPES` + `AUTO_APPROVE_CONFIDENCE` env vars are not read by any code. New rows are seeded by the api (`schema.sql` default + the startup reconciler) with `enabled=false`, `min_confidence=0.90` for all 27 types; the table is the only source of truth. Fail-closed semantics: when the api is unreachable AND no cache is populated yet, no document auto-approves — the operator's intent re-loads when the api is back.

### Corpus-driven learning (no model retraining)

- **Few-shot exemplars** (`FEW_SHOT_EXAMPLES`, default 0): each extraction prepends N most-recently-propagated docs as `(text excerpt, expected JSON)` pairs in the system prompt. Reads native fields (post-propagation ground truth) with fallback to `ai_*` custom fields.
- **Per-correspondent history hint** (`USE_CORRESPONDENT_HISTORY`, default true): builds `{sender: {document_type: count}}` from the `ai-propagated` corpus. If the document text mentions a known sender (longest substring match in first 1000 chars), prepends a German hint naming the dominant past type (≥70% of ≥2 prior docs) or the full distribution.

Together these turn user corrections into future signal: edit the AI fields pre-approval, OR rename a Correspondent post-propagation, and the next extraction sees the corrected version.

### Propagation (`propagate.processApprovedDocument`)

- Polls every 30s for `ai-approved`
- Reads `ai_correspondent` / `ai_document_type` / `ai_issue_date` / `ai_suggested_tags`
- Looks up or creates Paperless native entities (Correspondent, DocumentType, Tag) by exact-name match (`?name__iexact=`)
- Single PATCH: sets `correspondent`, `document_type`, `created_date`, `tags` (existing tags + propagated state + suggested tags merged; `ai-approved` removed)
- On success: tags `ai-propagated`. On any failure: tags `ai-propagation-error` (no retry loop).

### User actions in the UI

- **Retag a doc**: remove all `ai-*` lifecycle tags → poller/webhook re-extracts
- **Approve**: replace `ai-pending` with `ai-approved` → propagation within 30s
- **Reject**: replace `ai-pending` with `ai-rejected` → no propagation, doc untouched

### LLM backends

| Env                     | Backend                                       |
| ----------------------- | --------------------------------------------- |
| `LLM_BACKEND=ollama`    | Ollama at `http://host.docker.internal:11434` |
| `LLM_BACKEND=anthropic` | Anthropic API (`claude-sonnet-4-6`)           |

Switch by editing `docker/.env` and running `docker compose up -d auto-tagger aktenraum-api` (restart alone does NOT re-read env files — must use `up -d`). After source changes also use `--build`.

### Document taxonomy (27 types)

Rechnung · Gehaltsabrechnung · Kontoauszug · Nebenkostenabrechnung · Hausgeldabrechnung · Mahnung · Vertrag · Kündigung · Versicherung · Steuer · Lohnsteuerbescheinigung · Spendenbescheinigung · Bescheid · Behördenbrief · Sozialversicherungsmeldung · Kfz · Bußgeldbescheid · Arztbrief · Krankschreibung · Garantie · Urkunde · Ausweis · Zeugnis · Arbeitszeugnis · Mitgliedschaft · Beleg · Sonstiges

Defined in `packages/aktenraum-core/src/models/extraction.ts` `DocumentType`. Prompt definitions in `services/auto-tagger/src/prompt.ts` `SYSTEM_PROMPT` (with explicit disambiguation rules — read before editing; its exact length is pinned by a test so an accidental edit fails CI). Per-type extraction fields in `packages/aktenraum-core/src/models/typeSchema.ts` `TYPE_FIELD_SCHEMA`, typed as `Record<DocumentType, …>` so a missing type is a compile error.

**Gotchas — disambiguation rules baked into SYSTEM_PROMPT**:

- **Meldebescheinigung** has two flavours: the employer's annual "Meldebescheinigung zur Sozialversicherung" (DEÜV §25) → `Sozialversicherungsmeldung`; the Bürgeramt-issued address confirmation → `Behördenbrief`.
- **Lohnsteuerbescheinigung vs. Steuer**: the employer's annual §41b EStG certificate is its own type — keep it out of `Steuer`. `Steuer` is for Steuererklärungen / Anlagen; `Steuerbescheid` (Finanzamt-issued) goes to `Bescheid`.
- **Hausgeldabrechnung vs. Nebenkostenabrechnung**: WEG-Eigentümer get a `Hausgeldabrechnung` from the Hausverwaltung; tenants get a `Nebenkostenabrechnung` from the landlord. Wohngeldbescheid (housing benefit) is a `Bescheid`.
- **Bußgeldbescheid vs. Bescheid**: traffic fines split off into their own type — `Bescheid` is reserved for non-traffic admin acts.
- **Krankschreibung vs. Arztbrief**: short AU-Bescheinigung ("gelber Schein") is `Krankschreibung`; longer medical reports / findings stay in `Arztbrief`.
- **Spendenbescheinigung**: Zuwendungsbestätigung under §50 EStDV — distinct from `Rechnung`, `Mitgliedschaft`, or the user's own `Steuer` filing.

---

