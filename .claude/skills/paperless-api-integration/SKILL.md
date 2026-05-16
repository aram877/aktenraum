---
name: paperless-api-integration
description: Use when adding or modifying any code that calls Paperless's REST API — either via `PaperlessClient` in `packages/aktenraum-core/src/aktenraum_core/paperless/client.py` (auto-tagger side) or via `PaperlessGateway` in `services/aktenraum-api/src/aktenraum_api/paperless_gw.py` (BFF side). Documents the silently-ignored filters, the full-array PATCH semantics for custom_fields and tags, the date/monetary/string normalisers required at the boundary, the swap_lifecycle_tag TOCTOU retry loop, and the entity-cache TTL behaviour. Triggers on edits to those two files, on adding a new gateway method, or when investigating a "Paperless rejected the PATCH" / "field didn't show up in Paperless" debug session.
---

# Paperless API integration

Paperless's REST API has a handful of footguns that have each cost at least one debugging session in this repo. This skill is the canonical reference: every rule here exists because we got burned without it.

There are **two** clients in the codebase, both wrapping `httpx.AsyncClient`:

- `PaperlessClient` (`packages/aktenraum-core/src/aktenraum_core/paperless/client.py`) — used by the auto-tagger (extraction + propagation + indexing). Lives in the core package so it can be shared.
- `PaperlessGateway` (`services/aktenraum-api/src/aktenraum_api/paperless_gw.py`) — the BFF-side gateway. Holds the Paperless API token; never returns it to a caller. The SPA never has the token.

They share most of the gotchas below. Where the two diverge, the rule says which.

---

## Rule 1 — `?name=` is silently ignored on `/api/tags/`

```python
# WRONG — returns the first page of tags regardless of `name`
resp = await client.get("/api/tags/", params={"name": "ai-pending"})

# RIGHT — exact-match filter that actually works
resp = await client.get("/api/tags/", params={"name__iexact": "ai-pending"})
```

Same applies to `/api/correspondents/` and `/api/document_types/`. Always use `?name__iexact=`. Then **also** do a Python-side `if x["name"] == name` re-check on the response, as defence in depth — `_get_or_create_named` and `_get_tag_id` in `client.py` both do this.

---

## Rule 2 — `custom_fields` PATCH is full-array replace, not partial upsert

This is the single most expensive gotcha in the repo. Paperless's PATCH on `custom_fields` **replaces the entire array**. Sending `{"custom_fields": [{"field": 5, "value": "X"}]}` when the doc has 11 other fields will **delete the other 11**.

Two helpers handle this correctly:

- `PaperlessClient.patch_document_ai_fields()` — for the auto-tagger's initial extraction PATCH (builds the full set fresh, so no merge needed).
- `PaperlessGateway.patch_document_custom_fields()` — for partial updates from the inbox / library edit paths. **Reads the doc, merges by field id, writes back.**

If you write any new code that touches `custom_fields`, follow `_merge_custom_fields` in `paperless_gw.py` or use the existing helper. Don't roll your own.

```python
# RIGHT — read, merge, write
existing = await self.get_document(doc_id)
merged = _merge_custom_fields(
    existing.get("custom_fields") or [], update_by_id
)
await self._client.patch(
    f"/api/documents/{doc_id}/", json={"custom_fields": merged}
)
```

When the caller already has a fresh doc dict (e.g. inbox approve flow that just listed pending docs), pass it through `prefetched_doc=` to skip the merge-read:

```python
doc = await gateway.get_document(doc_id)
await gateway.patch_document_custom_fields(
    doc_id, populated, prefetched_doc=doc
)
```

---

## Rule 3 — every value must be normalised at the boundary

Paperless rejects almost every "natural" German format. The normalisers live in `packages/aktenraum-core/src/aktenraum_core/paperless/normalisers.py`. **Always run user-supplied values through them before PATCHing.**

| Field type | Format Paperless wants | What users emit | Helper |
| --- | --- | --- | --- |
| `data_type=date` | strict `YYYY-MM-DD` | `01.12.2024`, `12-2024`, `Dezember 2024` | `_normalize_date` |
| `data_type=monetary` | `EUR149.99` (ISO + amount, no separator) | `149,99 EUR`, `€149.99`, `EUR 149,99` | `_normalize_monetary` |
| `data_type=string` | max **128 chars** total | anything longer | `truncate_for_field` (ellipsis at 128) |
| `data_type=longtext` | unlimited | n/a — pass through | `truncate_for_field` consults `LONGTEXT_FIELDS` |

The `LONGTEXT_FIELDS` allowlist currently contains `{"ai_summary_de"}`. To add a new longtext field:

1. Extend `LONGTEXT_FIELDS` in `normalisers.py`.
2. Add the matching `ensure_custom_field … "longtext"` line in `scripts/bootstrap-paperless.sh`.
3. Run `scripts/migrate-ai-summary-to-longtext.sh` (rename for the new field) to migrate existing installs.

`PaperlessGateway._normalise_field_values` already does all this for the inbox/library edit path. Just call `patch_document_custom_fields`; it normalises before sending.

---

## Rule 4 — `swap_lifecycle_tag` is the only way to flip lifecycle tags

`PaperlessGateway.swap_lifecycle_tag(doc_id, remove=[...], add=[...])` is TOCTOU-safe:

1. Reads the doc's current tags.
2. Plans the new tag array via the pure `_plan_tag_swap`.
3. PATCHes.
4. **Re-reads to verify** the result matches the plan.
5. If a concurrent writer interleaved, replays the swap on the fresh state — up to 3 attempts.
6. On the 3rd consecutive race, raises `PaperlessConflictError` → HTTP 409.

Never write a manual read-modify-write loop on the `tags` array. The naïve version silently clobbered concurrent propagation tags before we added this. Routes that call `swap_lifecycle_tag` should catch `PaperlessConflictError`:

```python
except PaperlessConflictError as e:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"Document {doc_id} was modified concurrently. Refresh and try again.",
    ) from e
```

The auto-tagger has its own `_apply_tags` in `tagger.py:_apply_tags` that adds tags additively (union with existing). That's fine for extraction's *initial* tagging because nothing else is touching the doc yet, but for any state change (pending→approved, approved→propagated) use `swap_lifecycle_tag`.

---

## Rule 5 — the `_get_or_create_named` race is real

Two parallel propagator coroutines can both miss the cache for the same correspondent, both POST, and the loser of the race gets 400 from the unique-name constraint. The fix in `_get_or_create_named` (`client.py`) is: on POST 400, re-GET once and reuse the winner's id.

Any new code that creates Paperless entities by name should follow the same pattern. Don't bubble the 400 — it just tags the doc `ai-propagation-error` for no good reason.

---

## Rule 6 — entity caches are TTL'd (5 min default), invalidated on creates

`PaperlessClient` and `PaperlessGateway` both cache:

- Tag-name → tag-id (`_get_tag_id` / `list_tags`)
- Custom-field-name → custom-field-id (`_get_custom_field_ids`)
- Entity-name maps for correspondents / document_types / tags (`get_entity_name_map`)

TTL is 5 minutes. Create paths (`_get_or_create_named`, `ensure_tag`, `ensure_custom_field`) invalidate their own cache key so freshly-created entities are immediately visible.

**When something out-of-band changes Paperless state** (operator just ran `scripts/bootstrap-paperless.sh`, deleted a tag in the Paperless UI, etc.), call `client.invalidate_caches()` to wipe everything.

The gateway also auto-refreshes the custom-field cache once on an unknown field name before logging `paperless_unknown_custom_field` — so adding a new custom field doesn't require a container restart.

---

## Rule 7 — Paperless's content-OCR date detector cannot be disabled

`documents/consumer.py:430` inside Paperless runs a date detector over OCR text when the parser ships no PDF metadata date. It commonly grabs birthdates from CVs / IDs. Workarounds:

1. Make sure `ai_issue_date` is correct so the propagator overrides it.
2. For known recurring bad dates, set `PAPERLESS_IGNORE_DATES` env var in `docker/.env`.

The propagator's `created_date` write happens AFTER Paperless's auto-detection, so it takes precedence — but only on `ai-approved` docs that reach propagation.

---

## Rule 8 — `apache/tika`, NOT `ghcr.io/paperless-ngx/tika`

The GHCR variant requires auth and returns 403. The compose file uses `apache/tika:latest`. If you see a 403 on tika, this is why.

---

## Rule 9 — OCR fragments numbers

OCR routinely renders `28.02.24` as `2 8. 0 2.24`. The `SYSTEM_PROMPT` in `tagger.py` explicitly teaches the LLM to recognise this pattern. Keep that rule when editing the prompt.

If you write a regex over OCR content (like the new `_extract_reference_numbers_from_text`), assume numbers may be space-fragmented and either tolerate it or accept lower recall.

---

## Rule 10 — Paperless dedupes uploads by SHA1

Re-uploading the same file is a silent no-op on Paperless's side. Don't write code that relies on receiving a fresh task UUID for every upload — the second upload may quietly return the original.

---

## What goes where

When in doubt about which client to use:

- **In `aktenraum-api` (FastAPI side, BFF)** → `PaperlessGateway` via the `get_paperless_gateway` dependency. The gateway holds the token and is the only thing that should ever send it on the wire.
- **In the auto-tagger (background worker)** → `PaperlessClient`. Initialised once per process in `run()`.

The token lives in three places only:
1. `docker/auto-tagger.env` (mounted into the auto-tagger container as `PAPERLESS_API_TOKEN`).
2. `docker/aktenraum-api.env` (mounted into the aktenraum-api container as `PAPERLESS_API_TOKEN`).
3. **Never** anywhere else. Not in logs, not in error responses, not in the SPA bundle.

---

## Test pattern

Tests for any code that talks to Paperless should mock the gateway/client and assert on the calls. The existing test suites use `unittest.mock.AsyncMock`:

```python
gw = AsyncMock()
gw.list_tags = AsyncMock(return_value={"ai-pending": 1, ...})
gw.patch_document_custom_fields = AsyncMock(
    side_effect=lambda doc_id, kv, **_kw: kv  # accept the new prefetched_doc kwarg
)
```

Note the `**_kw` — when adding a new optional kwarg to a gateway method, every test mock that uses `side_effect=lambda` needs to accept it or those tests break.

---

## Don't

- Don't `?name=` on entity endpoints — it returns the first page silently.
- Don't single-field PATCH on `custom_fields` — you'll wipe everything else.
- Don't write raw German monetary or dates into `data_type=monetary` / `data_type=date` fields — normalise first.
- Don't trust the SPA to send normalised values — the user types `01.12.2024` and expects it to work.
- Don't hand-roll a read-modify-write on `tags` — use `swap_lifecycle_tag`.
- Don't cache the Paperless token in the SPA bundle, ever.
- Don't catch+swallow gateway errors silently — the auto-tagger relies on the `ai-error` / `ai-propagation-error` tag transitions, and the API relies on the typed exceptions for HTTP status mapping.
