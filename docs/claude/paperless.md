# Paperless API reference, gotchas and boundary validation

> Moved out of CLAUDE.md to keep the always-loaded context small. Read this when working in this area.

## Paperless API quick reference

```bash
TOKEN="$(grep PAPERLESS_API_TOKEN docker/.env | cut -d= -f2)"
BASE="http://localhost:8000"

# Mint a fresh token (use after starting paperless on an empty DB)
curl -s -X POST "$BASE/api/token/" -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"test1234"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])"

# All tags
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?page_size=200" | python3 -c "import sys,json; [print(t['id'], t['name']) for t in json.load(sys.stdin)['results']]"

# Look up a specific tag by name (use ?name__iexact=, NOT ?name=)
curl -s -H "Authorization: Token $TOKEN" "$BASE/api/tags/?name__iexact=ai-pending"

# Clear tags from a document (sends it back to the extraction queue)
curl -s -X PATCH "$BASE/api/documents/{id}/" -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" -d '{"tags": []}'

# Trigger extraction directly via the auto-tagger webhook (bypasses the 30s poll lag)
docker compose exec paperless curl -sS -H "Content-Type: application/json" \
  -d '{"document_id": 12}' http://auto-tagger:8001/trigger/extract
```

### Paperless API gotchas (each cost a debug session)

- **`?name=` is silently ignored on `/api/tags/`** — it returns the default first page regardless. Use `?name__iexact=<name>` for exact match. The client-side equality check stays as defence in depth (see `PaperlessClient` in `@aktenraum/core`).
- **Custom fields with `data_type=string` have a hard 128-char DB limit.** Anything longer 400s the entire PATCH. We truncate at the boundary in `@aktenraum/core` `paperless/normalisers.ts` (ellipsis at 128 chars). The complementary `data_type=longtext` (Paperless 2.x+) has no length cap; fields backed by it must NOT be truncated. Use `truncateForField(name, value)` at the boundary — it consults the `LONGTEXT_FIELDS` allowlist (currently `{"ai_summary_de"}`) and skips truncation for those. To add a new longtext field: extend `LONGTEXT_FIELDS`, add the matching `ensure_custom_field … "longtext"` line in `scripts/bootstrap-paperless.sh`, and run `scripts/migrate-ai-summary-to-longtext.sh` (rename for the new field) to migrate existing installs.
- **Custom fields with `data_type=monetary` require the format `<ISO_CODE><amount>`** (e.g., `EUR149.99`) — the German format `149,99 EUR` is rejected. We normalise via `normalizeMonetary` (handles symbols, German/Anglophone thousands separators).
- **Custom fields with `data_type=date` require strict YYYY-MM-DD.** German `DD.MM.YYYY`, slashes, month-year-only all rejected. We normalise via `normalizeDate`.
- **Paperless's content-OCR date detector cannot be disabled.** It runs in the consumer (`documents/consumer.py:430`) when the parser ships no PDF metadata date and grabs _any_ date from the OCR text. It commonly picks up birthdates from CVs / IDs. Workaround: rely on the AI's `ai_issue_date` being correct so propagation overrides it; for a known recurring bad date use `PAPERLESS_IGNORE_DATES` env var.
- **Tags, correspondents and document types are created with `owner: null`** (shared vocabulary, ADR-009) — `PaperlessClient.getOrCreateNamed`/`ensureTag`, `PaperlessGateway.ensureTag` and `bootstrap-paperless.sh`. If Paperless still returns an owner, one PATCH clears it (`paperless_clear_owner_failed` when that fails, never fatal). A metadata object owned by one user is invisible to every other non-superuser Paperless user.
- **Custom fields data type cannot be changed after creation.** Plan field types up front; recreate to migrate.
- **OCR fragments numbers with spaces** ("28.02.24" → "2 8. 0 2.24"). The system prompt explicitly tells the LLM to recognise this; keep that rule when editing.

---

## Validation patterns at the LLM/Paperless boundary

Local LLMs (especially small ones like gemma4 8B) emit data the Paperless API rejects on edge cases. We layer two defences: schema-level coercion at the zod boundary, and value normalisation at the PATCH boundary.

| Issue                                                                           | Where                                                             | Fix                                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| LLM returns `null` for a list field instead of `[]`                             | `CoercedListSchema` (`models/extraction.ts`, `z.preprocess`)       | Coerces None → []                                                                             |
| LLM returns int in a list of strings (e.g. `[42, "text"]`)                      | `CoercedStrSchema` (`models/extraction.ts`, `z.preprocess`)        | Coerces to str                                                                                |
| LLM emits monetary as German `"149,99 EUR"`; Paperless wants `"EUR149.99"`      | `normalizeMonetary` (`paperless/normalisers.ts`)                  | Regex parse + ISO-format reformat                                                             |
| LLM emits date as `"01.12.2024"` or `"12-2024"`; Paperless wants `"YYYY-MM-DD"` | `normalizeDate` (`paperless/normalisers.ts`)                      | strptime against a list of common formats                                                     |
| LLM emits a string longer than Paperless's 128-char custom-field limit          | `truncateForField` (`paperless/normalisers.ts`)                   | Truncates `string` fields; passes `longtext` fields (e.g. `ai_summary_de`) through unmodified |
| LLM suggests a lifecycle tag (`ai-approved`) as a real tag                      | `splitSuggestedTags` (`auto-tagger/src/propagate.ts`)             | Filter out lifecycle names                                                                    |
| LLM suggests a tag truncated by the 128-char limit (ends with `…`)              | `splitSuggestedTags` (`auto-tagger/src/propagate.ts`)             | Drop fragments ending in ellipsis                                                             |
| Paperless 4xx hides the validation reason                                       | `PaperlessClient.patchDocumentNativeFields` + `getOrCreateNamed`  | Log response body via `paperless_patch_rejected` / `paperless_create_rejected` events         |

---

