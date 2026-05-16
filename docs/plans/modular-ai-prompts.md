# Plan: Modular AI Prompts

**Status:** Implemented (2026-05-16)
**Motivation:** Static prompts cause "nicht gefunden" failures when the LLM
gets irrelevant instructions for the doc types at hand. The 26 doc types in
`DocumentType` each have their own typespecific fields (`TYPE_FIELD_SCHEMA`);
the current answer prompt enumerates them in one dense line and the filter
prompt has only six static few-shots. Two concrete failures we have observed:

1. **Filter:** "Wie viel habe ich in 2025 verdient?" was returning all 2025
   docs because nothing mapped salary verbs → `Gehaltsabrechnung`. We added
   one few-shot for it manually, but the same gap exists for tax, insurance,
   rent and so on.
2. **Answer:** when the candidates are pure Versicherung docs the model
   still sees Wizz-Air / Personalausweis examples in its prompt — domain
   guidance that adds tokens without adding signal.

The fix is to assemble the typed pieces of the prompt at request time from
the doc-type modules below.

---

## Adjusted scope

Three corrections versus the original draft:

1. **26 doc types, not 22.** Every `DocumentType` enum value gets a module,
   even when the module is mostly empty (e.g. `Sonstiges`) — the integrity
   test asserts coverage of the enum so future additions cannot drift.
2. **Do not duplicate `TYPE_FIELD_SCHEMA`.** The Pydantic schema already
   carries `(name, label_de, field_type)` for every typed field. Modules
   provide only *intent-aware* additions (filter few-shots and one
   demonstrative answer example) and pull field labels from
   `TYPE_FIELD_SCHEMA` at render time. Drift is eliminated by construction.
3. **Split where each signal applies.** The filter prompt has *no*
   candidates yet, so it uses keyword-driven intent detection. The answer
   prompt *does* have candidates — the set of `document_type` values
   already present in `candidates` is a more reliable signal than keyword
   matching on the question. So intent feeds the filter prompt only; the
   answer prompt drives off candidate types directly.

---

## What changes

### Phase 1 — Intent detection (`ai/intent.py`)

Lightweight keyword classifier on the user's question. No extra LLM call.
Multiple intents can fire on one question.

| Intent | Trigger keywords | Implied doc type(s) |
|---|---|---|
| `salary` | verdient, gehalt, nettolohn, bruttolohn, lohn, lohnabrechnung, auszahlung | Gehaltsabrechnung |
| `spending` | ausgegeben, kosten, bezahlt, preis, gekostet | Rechnung, Mahnung |
| `tax` | steuer, steuerbescheid, erstattung, finanzamt, lohnsteuerbescheinigung | Steuer, Lohnsteuerbescheinigung |
| `insurance` | versicherung, prämie, police, selbstbeteiligung | Versicherung |
| `housing` | nebenkosten, hausgeld, miete, vorauszahlung | Nebenkostenabrechnung, Hausgeldabrechnung |
| `medical` | arzt, diagnose, krankschreibung, au-bescheinigung, befund | Arztbrief, Krankschreibung |
| `id_document` | pass, ausweis, perso, führerschein, gültig, ablauf | Ausweis, Kfz |
| `contract` | vertrag, kündigung, frist | Vertrag, Kündigung |

Intents without a doc-type binding (date-only, freetext) are *not* in the
table — they fall through to the existing static few-shots. Adding more
intents is opening this table; the helper is a single pure function and
trivially extensible.

Signature: `detect_intents(question: str) -> set[Intent]`.

### Phase 2 — Per-doc-type field modules (`ai/prompt_modules.py`)

One entry per `DocumentType`. Each module carries:

- `filter_examples`: extra few-shot pairs *(question, filter dict)* that the
  filter prompt injects when an intent that implies this doc type fires.
- `answer_example`: one assembled string demonstrating field use, in the
  same shape as the static citation-marker example in
  `_streaming_user_prompt`.
- `answer_hint`: a single German sentence summarising which fields hold
  the canonical value for the most common question shape on this type.
  Used in the dynamic "Feld-Hinweise" block.

Field *labels* and *names* are looked up from `TYPE_FIELD_SCHEMA` at render
time — modules never spell them out, so when a new typed field is added
to `TYPE_FIELD_SCHEMA` it appears in the prompt automatically.

```python
@dataclass(frozen=True)
class DocTypeModule:
    filter_examples: tuple[tuple[str, dict], ...] = ()
    answer_hint: str = ""
    answer_example: str = ""

MODULES: dict[DocumentType, DocTypeModule] = {
    DocumentType.Gehaltsabrechnung: DocTypeModule(
        filter_examples=(
            ("Wie viel habe ich im März 2025 verdient?", {
                "document_type": "Gehaltsabrechnung",
                "date_from": "2025-03-01", "date_to": "2025-03-31",
            }),
        ),
        answer_hint=(
            "Bei Gehaltsabrechnungen liegen Brutto- und Nettogehalt in den "
            "typenspezifischen Feldern; ergänze ggf. Steuerklasse oder Lohnsteuer."
        ),
        answer_example=(
            "Frage: 'Wie viel habe ich im März 2025 netto verdient?'\n"
            "Typenspezifische Felder: Bruttogehalt: EUR4820.00, Nettogehalt: EUR3144.16\n"
            "→ 'Im März 2025 hast du brutto 4.820,00 € und netto 3.144,16 € verdient. [Quelle: 126]'"
        ),
    ),
    # ... 25 more entries; ones without obvious shapes carry empty defaults
}
```

### Phase 3 — Dynamic filter prompt assembly (`ai/prompt.py`)

- `build_messages` already receives `query`; thread it into
  `_build_system_prompt`.
- `detect_intents(query)` → set of intents → flatten into doc types →
  union the `filter_examples` from each matched module after the static
  few-shot block.
- Static few-shots stay as the always-on baseline so questions outside
  any intent table keep working.

### Phase 4 — Dynamic answer prompt assembly (`ai/answer_prompt.py`)

The streaming and JSON variants both:

1. Read distinct `document_type` strings from `candidates`.
2. Convert each to its `DocumentType` enum value, drop unknown / `Sonstiges`.
3. For each matched type, append:
   - "Bei *<Type>*-Dokumenten gehören diese Felder zu den Antworten: *<comma-separated labels from TYPE_FIELD_SCHEMA>*. *<answer_hint>*"
4. For each matched type, append the module's `answer_example`.
5. Always keep the citation-format examples (`[Quelle: N]` single-source and
   multi-source aggregation). These teach the *syntax* of citing, not
   domain field use — orthogonal to modules.
6. If no candidate matches a known module, fall back to a short
   "use the typespecific fields if any are populated" sentence so the
   prompt is never empty in the degenerate case.

The current 4 domain examples (Pass / Stromrechnung / Wizz Air / August
2025 verdient) move into the relevant modules; only the citation-marker
shape examples remain hardcoded.

---

## Files

| File | Action |
|---|---|
| `services/aktenraum-api/src/aktenraum_api/ai/intent.py` | Create |
| `services/aktenraum-api/src/aktenraum_api/ai/prompt_modules.py` | Create |
| `services/aktenraum-api/src/aktenraum_api/ai/prompt.py` | Extend (intent injection) |
| `services/aktenraum-api/src/aktenraum_api/ai/answer_prompt.py` | Refactor (dynamic assembly) |
| `services/aktenraum-api/tests/test_ai_intent.py` | Create |
| `services/aktenraum-api/tests/test_ai_prompt_modules.py` | Create |
| `services/aktenraum-api/tests/test_ai_prompt.py` | Extend (intent-driven few-shot assertions) |
| `services/aktenraum-api/tests/test_ai_answer.py` | Extend (dynamic assembly assertions) |

## Out of scope

- No extra LLM call for intent classification (keyword scan only, < 1 ms).
- No changes to the extraction pipeline or the auto-tagger.
- No changes to the RAG retrieval layer.
- No deletion of the existing citation-format examples in
  `_streaming_user_prompt` — they teach the inline `[Quelle: N]` syntax,
  which is orthogonal to per-type field guidance.
