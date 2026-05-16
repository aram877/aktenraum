# Plan: Modular AI Prompts

**Status:** Planned  
**Motivation:** Static prompts cause "nicht gefunden" failures when the LLM gets irrelevant
instructions for the doc types at hand. 22 doc types need type-specific field guidance.

---

## What changes

### Phase 1 — Intent detection (`ai/intent.py`)

Lightweight keyword classifier on the user's question. No extra LLM call.

| Intent | Keywords | Implied doc type |
|---|---|---|
| `salary` | verdient, gehalt, nettolohn, bruttolohn, lohn, auszahlung | Gehaltsabrechnung |
| `spending` | ausgegeben, kosten, bezahlt, preis | Rechnung, Mahnung |
| `date_lookup` | wann, datum, gültig, verlängern, ablauf | any |
| `tax` | steuer, steuerbescheid, erstattung, finanzamt | Steuer, Lohnsteuerbescheinigung |
| `insurance` | versicherung, prämie, police | Versicherung |
| `content` | was steht, inhalt, details, klausel | any |
| `aggregation` | insgesamt, gesamt, summe, total | any |

### Phase 2 — Per-doc-type field modules (`ai/prompt_modules.py`)

One entry per doc type mapping field names to plain-German explanations + query hint.
Used by both the filter prompt and the answer prompt.

```python
MODULES: dict[DocumentType, DocTypeModule] = {
    DocumentType.Gehaltsabrechnung: DocTypeModule(
        filter_keywords=["verdient", "gehalt", "lohn", "nettolohn"],
        field_hints={
            "nettogehalt":  "Auszahlungsbetrag nach Steuern und SV",
            "bruttogehalt": "Gesamtbezüge vor Abzügen",
            "lohnsteuer":   "Einbehaltene Lohnsteuer",
            "abrechnungsmonat": "Abrechnungszeitraum (YYYY-MM)",
        },
        answer_example=(
            "Frage: 'Wie viel habe ich im März 2025 netto verdient?'\n"
            "Felder: Nettogehalt: EUR3144.16\n"
            "→ 'Im März 2025 hast du 3.144,16 € netto verdient. [Quelle: X]'"
        ),
    ),
    DocumentType.Rechnung: DocTypeModule(...),
    # ... all 22 types
}
```

### Phase 3 — Dynamic filter prompt assembly (`ai/prompt.py`)

- Detect intent from question
- Inject type-specific filter examples for the matched intent
- Current generic examples stay as fallback

### Phase 4 — Dynamic answer prompt assembly (`ai/answer_prompt.py`)

- Inspect which doc types are present in `candidates`
- Load `MODULES[doc_type].field_hints` only for present types
- Pick `answer_example` entries from matched types
- Replace hardcoded hint block and 3 static examples with assembled content

---

## Files

| File | Action |
|---|---|
| `services/aktenraum-api/src/aktenraum_api/ai/intent.py` | Create |
| `services/aktenraum-api/src/aktenraum_api/ai/prompt_modules.py` | Create |
| `services/aktenraum-api/src/aktenraum_api/ai/prompt.py` | Extend |
| `services/aktenraum-api/src/aktenraum_api/ai/answer_prompt.py` | Refactor |
| `services/aktenraum-api/tests/test_prompt_modules.py` | Create |

## Out of scope

- No extra LLM call for intent classification (keyword scan only, < 1 ms)
- No changes to the extraction pipeline or auto-tagger
- No changes to the RAG retrieval layer
