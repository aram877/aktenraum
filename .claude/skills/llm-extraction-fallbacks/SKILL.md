---
name: llm-extraction-fallbacks
description: Use when adding fields to DocumentExtraction or any LLM-extracted Pydantic schema in this repo, when investigating why a field arrives empty from the small local LLM, or when adding new ai_* custom fields. Documents the small-LLM field-drop problem rooted in Pydantic defaults, the post-extraction synthesizer pattern, the OCR-regex heuristic for ref-numbers, and the prompt-tightening conventions. Triggers when editing services/auto-tagger/src/auto_tagger/tagger.py, packages/aktenraum-core/src/aktenraum_core/models/extraction.py, or seeing a user report like "ai_summary_de / ai_title / reference_numbers is empty".
---

# LLM extraction fallbacks

The auto-tagger asks an LLM to fill a `DocumentExtraction` Pydantic model. **Small local models (≤8B class) routinely drop fields that have Pydantic defaults.** This skill documents the canonical pattern for catching those drops.

---

## Why it happens (root cause)

Pydantic accepts default values silently. If `DocumentExtraction.summary_de` has `Field(default="")`, an LLM that omits the key produces a model where `summary_de == ""` — and **no validation error fires**. The Ollama backend's retry loop only triggers on `ValidationError` or `JSONDecodeError`, so the empty value flows straight through to Paperless.

When you serialise the schema with `response_schema.model_json_schema()` (the Ollama backend does this in `_clean_json` / `complete`), fields with a default are **not** in the `"required"` array. The LLM treats them as optional and small models routinely skip them.

The choices are:

1. **Mark the field as required (`Field(...)` instead of `Field(default=...)`).** Forces the LLM via retry. Often ends in `ai-error` because the small model still can't comply after 3 attempts. Bad UX.
2. **Synthesise a deterministic fallback after extraction.** Always non-empty. Quality is modest but predictable. Used for `ai_title`, `confidence_reason`, `summary_de`.
3. **Heuristically extract from the OCR text.** Works when the field has predictable structure (German reference-number labels). Used for `reference_numbers`.
4. **Prompt-only tightening.** Helps statistically but doesn't guarantee anything. Used for `suggested_tags` (no good synthesizer exists).

---

## The synthesis pattern (the canonical fix)

Pattern, in order of strength:

1. **A pure helper function** that builds a value from other fields on the same `DocumentExtraction`. Always non-empty if `document_type` is set (which it always is — it's the only `Field(...)`-required field on the model).
2. **Wire it after `backend.complete(...)`** in `process_document` (`tagger.py`). Trigger condition: the LLM-emitted value is empty / blank / whitespace.
3. **Emit a `*_synthesized` log event** so the run is auditable.
4. **Add unit tests** under `services/auto-tagger/tests/test_tagger.py` covering: full extraction, minimal extraction, missing correspondent, missing date, doc-type-only.

### Concrete examples already in the codebase

| Field | Synthesizer | Wired at | Log event |
| --- | --- | --- | --- |
| `ai_title` | `_synthesize_ai_title(extraction)` builds `<DocType> · <Correspondent> · <Monat Jahr>` | Right after `backend.complete()` returns | `ai_title_synthesized` |
| `confidence_reason` | `_fallback_confidence_reason(confidence)` picks a tier-appropriate German sentence | After ai_title | `confidence_reason_synthesized` |
| `reference_numbers` | `_extract_reference_numbers_from_text(content)` regex-sweeps OCR | After confidence_reason | `reference_numbers_harvested` |
| `summary_de` | `_synthesize_summary_de(extraction)` builds 1-3 German sentences from all other fields | After reference_numbers | `summary_de_synthesized` |

All four follow the same shape:

```python
if not (extraction.<field> or "").strip():           # or `not extraction.<list_field>`
    synthesized = _synthesize_<field>(extraction)    # or other inputs
    extraction = extraction.model_copy(update={"<field>": synthesized})
    logger.info("<field>_synthesized", ...)
```

Critical: **the LLM's value wins whenever it's non-empty.** Synthesizers only fire on the empty path. A larger model's natural-language summary is always better than the deterministic fallback.

---

## The OCR-regex pattern (for `reference_numbers`)

When the field has structured German labels in the source text, a conservative regex can recover values the LLM dropped. See `_extract_reference_numbers_from_text` and `_REFERENCE_PATTERNS` in `tagger.py`.

Rules for the regex:

- **Require a labelled prefix.** Bare alphanumeric runs would harvest dates, phone numbers, IBANs. Each pattern starts with one of: `Aktenzeichen:`, `Az.:`, `Rechnungs-Nr.:`, `Vertrags-Nr.:`, `Kunden-Nr.:`, `Vorgangs-Nr.:`, `Bestell-Nr.:`, `Auftrags-Nr.:`, `Policen-Nr.:`, `Steuer-Nr.:`.
- **Bound the captured value at 32 chars.** Glued OCR can produce runaway captures.
- **Min 4 chars (one leading char + 3 follow-on).** Two-letter values are almost always false positives.
- **Case-insensitive on the label, case-preserving on the value.** Run via `re.IGNORECASE`.
- **Dedup case-insensitively, output case-preserved.** "K-100" and "k-100" are the same number.
- **Cap output count.** Default 5; the user can review and prune.
- **Read from full `content`, not the LLM-truncated `text`.** Ref numbers often sit at the end of long docs.

If you add a new field that fits this shape (e.g. `iban`, `vertragspartner_nummer`), follow the same structure: a `_<field>_PATTERNS` tuple + an extractor + a fire-on-empty wire in `process_document`.

---

## When NOT to synthesize

`suggested_tags` deliberately has no synthesizer. Auto-generating "tags" from doc_type / year / correspondent would produce noisy results that the propagator then materialises as **real Paperless tags** — and once those tags exist, they're hard to clean up. Better to leave the list empty and rely on the prompt rule + the user adding tags manually in the inbox UI.

Rule of thumb: only synthesize when

1. Empty is **never** correct (i.e. the field is more useful with a deterministic placeholder than with nothing), AND
2. The synthesizer can produce a value that's **not actively wrong** (e.g. a summary of "Rechnung von X vom Y" is informative; a fake tag "2024" pollutes the corpus).

`suggested_tags` fails the second test, so it's prompt-only.

---

## The prompt-rule convention

Per-field rules in the `SYSTEM_PROMPT` (`tagger.py`) follow this shape:

```
- <field>: <PFLICHTFELD | optional>. <one-line semantic>.
  • <sub-rule 1 with concrete example>
  • <sub-rule 2 with concrete example>
  Verbiete: <antipattern>. Beispiel: "…".
```

The recent `summary_de` / `reference_numbers` / `suggested_tags` tightening is the reference shape. Look at lines around `- summary_de: PFLICHTFELD, NIE leer.` in `tagger.py` for the layout.

Three things keep small models on track:

1. **`PFLICHTFELD, NIE leer`** in front for fields that must be non-empty.
2. **Per-sentence shape** (`Satz 1 — …; Satz 2 — …`) when the field has internal structure.
3. **Worked German examples** specific to common document types in this corpus (Rechnung, Mietvertrag, Bescheid).

Negative examples (`Verbiete: …`) help too — small models otherwise produce "high confidence" / "alles eindeutig" floskeln on every doc.

---

## Adding a new ai_* field — full checklist

1. **Add to `DocumentExtraction`** in `extraction.py`. Decide: required (`Field(...)`) or optional-with-default (`Field(default=...)`).
2. **Add to `SYSTEM_PROMPT`** in `tagger.py` with a per-field rule following the convention above.
3. **Add to `patch_document_ai_fields`** in `client.py` — extend the `fv()` calls and the truncation logic.
4. **Add the custom field in Paperless** — extend `scripts/bootstrap-paperless.sh` with `ensure_custom_field "ai_<field>" "string"` (or `monetary`, `date`, `longtext`).
5. **Bootstrap existing installs** — manually call the bootstrap script on running paperless; the gateway's TTL cache will pick up the new field within 5 min (or call `gateway._custom_field_ids_cache = None` to force).
6. **If optional-with-default → add a synthesizer.** Follow the pattern above. Add unit tests.
7. **Add to the `InboxDetail` schema** in `services/aktenraum-api/src/aktenraum_api/inbox/schemas.py` if the SPA should see / edit it.
8. **Add to the SPA form** in `apps/web/src/routes/InboxReview.tsx` and `LibraryReview.tsx`.

Skip step 6 only if empty is genuinely correct (the `suggested_tags` decision).

---

## How to verify a fix on a real doc

```bash
task reprocess ID=<doc_id>
task logs SVC=auto-tagger | grep -E "synthesized|harvested"
```

You should see one or more of:

```
{"event": "ai_title_synthesized", "title": "..."}
{"event": "confidence_reason_synthesized", "reason": "..."}
{"event": "reference_numbers_harvested", "count": 2, "values": ["AZ-001", "RN-002"]}
{"event": "summary_de_synthesized", "chars": 142}
```

If none fire on a doc you expected them to, the LLM probably DID emit a value (check the doc's `ai_*` fields in Paperless / SPA). The fallbacks are gated on "empty" — a malformed but non-empty LLM output bypasses them.

---

## Don't

- Don't change `Field(default="")` to `Field(...)` without considering what happens when small models can't comply — you'll see `ai-error` tags everywhere.
- Don't synthesize tags or correspondents or document types — those go directly to native Paperless fields where wrong values are hard to clean up.
- Don't read from `text` (LLM-truncated) in OCR-regex extractors — use `content` so page-N values still surface.
- Don't drop the `*_synthesized` log event — that's how we audit whether the small model is improving or degrading over time.
- Don't add a new ai_* field without also updating `bootstrap-paperless.sh` — the field won't exist in Paperless and PATCH will silently skip it (logged as `paperless_unknown_custom_field`).
