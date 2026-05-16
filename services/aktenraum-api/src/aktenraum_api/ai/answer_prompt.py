"""Prompt for the conversational answer LLM call (POST /api/ai/answer).

The LLM gets a German question + a compact context of candidate documents
(only the AI metadata: summary, key dates, monetary, correspondent — not the
raw PDF). It returns `AnswerOutput` JSON: a German one-to-three-sentence
answer plus a list of cited document ids.

Pure function — no I/O.
"""

from __future__ import annotations

import json
from datetime import date

from aktenraum_core.models import DocumentType

from .prompt_modules import field_labels_for, module_for, parse_document_type


def build_answer_messages(question: str, *, candidates: list[dict]) -> list[dict]:
    """Return [system, user] messages for the answer LLM call.

    `candidates` shape (each item):
        {
          "id": int, "title": str, "correspondent": str|None,
          "document_type": str|None, "created": "YYYY-MM-DD"|None,
          "ai_summary_de": str|None, "ai_issue_date": str|None,
          "ai_reference_numbers": str|None,
        }
    """
    system = _system_prompt(candidates=candidates)
    user = _user_prompt(question, candidates, json_mode=True)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _system_prompt(*, candidates: list[dict]) -> str:
    parts: list[str] = []
    parts.append(
        "Du bist ein Assistent für ein persönliches Dokumenten-System. "
        "Beantworte die Frage des Nutzers AUSSCHLIESSLICH auf Basis der "
        "bereitgestellten Dokumente. Wenn die Antwort nicht in den Dokumenten "
        "steht, sage das ehrlich."
    )
    parts.append("Regeln:")
    parts.append("- Antworte auf Deutsch.")
    parts.append("- Halte die Antwort kurz: höchstens 3 Sätze.")
    parts.append(
        "- Nenne in 'cited_ids' die IDs aller Dokumente, aus denen Informationen "
        "stammen. Maximal 3 IDs."
    )
    parts.append(
        "- Wenn keines der Dokumente die Frage beantwortet, gib eine kurze "
        "deutsche Antwort wie 'Ich konnte das in den Dokumenten nicht finden.' "
        "und lass cited_ids leer."
    )
    parts.append("- Erfinde keine IDs. Verwende nur IDs aus der Liste.")
    parts.append(
        "- Format der Antwort: gültiges JSON nach dem vorgegebenen Schema."
    )
    parts.append(f"- Heute ist {date.today().isoformat()}.")
    parts.append("")
    parts.extend(_assembled_field_hints(candidates))
    return "\n".join(parts)


def _user_prompt(
    question: str,
    candidates: list[dict],
    *,
    json_mode: bool,
) -> str:
    parts: list[str] = []
    parts.append("Beispiele wie du Felder verwendest:")
    for example in _assembled_examples(candidates, json_mode=json_mode):
        parts.append(example)
    parts.append("")
    parts.append(f"Frage: {question}")
    parts.append("")
    parts.append("Verfügbare Dokumente:")
    if not candidates:
        parts.append("(keine)")
    else:
        for c in candidates:
            parts.append(_render_candidate(c))
    parts.append("")
    parts.append(
        "Antworte JETZT mit JSON: "
        '{"answer_de": "...", "cited_ids": [...]}.'
    )
    return "\n".join(parts)


def _candidate_doc_types(candidates: list[dict]) -> list[DocumentType]:
    """Distinct DocumentType values from candidates, ordered by first appearance.

    Unknown / null types are dropped silently. Order matters for prompt-cache
    stability so we walk `candidates` in input order rather than sorting.
    """
    seen: set[DocumentType] = set()
    out: list[DocumentType] = []
    for c in candidates:
        dt = parse_document_type(c.get("document_type"))
        if dt is None or dt in seen:
            continue
        seen.add(dt)
        out.append(dt)
    return out


def _assembled_field_hints(candidates: list[dict]) -> list[str]:
    """Per-doc-type "Feld-Hinweise" block based on candidates.

    Always emits a header so the section is greppable. Falls back to a
    generic one-liner when no candidate matches a known module (empty
    list / all `Sonstiges` / all unknown types).
    """
    lines: list[str] = ["Feld-Hinweise (wichtig — nutze diese Felder direkt!):"]
    matched = False
    for dt in _candidate_doc_types(candidates):
        mod = module_for(dt)
        labels = field_labels_for(dt)
        if not mod.answer_hint and not labels:
            continue
        matched = True
        label_part = f" Felder: {', '.join(labels)}." if labels else ""
        hint_part = f" {mod.answer_hint}" if mod.answer_hint else ""
        lines.append(f"- {dt.value}-Dokumente —{label_part}{hint_part}".rstrip())
    if not matched:
        lines.append(
            "- Nutze die typenspezifischen Felder, wenn welche gefüllt sind. "
            "Wenn ein passendes Feld einen Wert hat, IST das die Antwort."
        )
    lines.append(
        "- Wenn ein passendes Feld bereits einen Wert hat, IST das die Antwort. "
        "Sage NICHT 'keine Information', wenn das Feld gefüllt ist."
    )
    return lines


def _assembled_examples(candidates: list[dict], *, json_mode: bool) -> list[str]:
    """Per-doc-type worked examples, one per distinct type present.

    The module examples target the streaming `[Quelle: N]` syntax. When
    `json_mode=True` (the non-streaming /answer endpoint) the same content
    is wrapped in the JSON envelope so the LLM sees the expected output
    shape for that path. Falls back to one generic citation-format example
    so the LLM always has at least one Beispiel to follow.
    """
    raw: list[str] = []
    for dt in _candidate_doc_types(candidates):
        example = module_for(dt).answer_example
        if example:
            raw.append(example)
    if not raw:
        raw.append(
            "Frage: 'Wann wurde mein Pass ausgestellt?'\n"
            "Dokument hat Ausstellung: 2024-05-12\n"
            "→ 'Dein Pass wurde am 12.05.2024 ausgestellt. [Quelle: 17]'"
        )
    if not json_mode:
        return raw
    return [_to_json_envelope(example) for example in raw]


def _to_json_envelope(streaming_example: str) -> str:
    """Convert a streaming `[Quelle: N]` example into the JSON-envelope form.

    Reuses the streaming module text as the source of truth so the two
    paths never drift. The conversion is deliberately textual rather
    than parsing-based — the examples are small fixed strings and the
    regex would not be more readable than a single .replace pass.
    """
    import re as _re

    # Replace the trailing `→ '… [Quelle: N]'` arrow line with the JSON form.
    def _swap(match: _re.Match[str]) -> str:
        prose = match.group(1).strip()
        cited = match.group(2)
        prose_clean = _re.sub(r"\s*\[Quelle:\s*\d+\s*\]\s*", "", prose).strip()
        return (
            f'→ {{"answer_de": "{prose_clean}", "cited_ids": [{cited}]}}'
        )

    return _re.sub(
        r"→\s*'(.+?\[Quelle:\s*(\d+)\s*\])'",
        _swap,
        streaming_example,
        flags=_re.DOTALL,
    )


def _render_candidate(c: dict, *, chunks: list[str] | None = None) -> str:
    """Compact one-block representation per candidate.

    Skipping null fields keeps the prompt small and avoids confusing the LLM
    with empty values it might try to reason about.

    `chunks` is the optional list of relevant text excerpts pulled from
    Qdrant by the RAG retrieval (Phase 1.9). When present, each chunk
    is rendered under "Relevante Auszüge:" so the model can answer
    questions whose answers live in the document body — durations,
    clauses, table values — not in the AI metadata fields.
    """
    fields: list[tuple[str, str | int | None]] = [
        ("ID", c.get("id")),
        ("Titel", c.get("title")),
        ("Typ", c.get("document_type")),
        ("Korrespondent", c.get("correspondent")),
        ("Eingangsdatum", c.get("created")),
        ("Ausstellung", c.get("ai_issue_date")),
        ("Referenzen", c.get("ai_reference_numbers")),
    ]
    rendered = "\n".join(
        f"  {label}: {value}" for label, value in fields if value not in (None, "")
    )
    summary = c.get("ai_summary_de")
    if summary:
        rendered += f"\n  Zusammenfassung: {summary}"
    # Pass-2 structured fields (Gehaltsabrechnung.bruttogehalt etc.). These
    # are the canonical money/date/identifier values stored in the
    # aktenraum DB. Surfacing them here is what makes questions like
    # "Wie viel habe ich verdient?" answerable WITHOUT relying on RAG
    # luckily retrieving the right span.
    type_specific = c.get("type_specific_fields") or []
    if type_specific:
        rendered += "\n  Typenspezifische Felder:"
        for f in type_specific:
            label = f.get("label") or f.get("name") or ""
            value = f.get("value")
            if value in (None, ""):
                continue
            rendered += f"\n    {label}: {value}"
    if chunks:
        rendered += "\n  Relevante Auszüge:"
        for i, chunk in enumerate(chunks, start=1):
            # The chunker bounds individual chunks to ~500 tokens
            # (~3 KB chars) by design. The reranker has already picked
            # the top-N most relevant chunks. So no per-chunk truncation
            # here — clipping mid-chunk would silently hide the
            # answer-relevant span (the original 2 KB cap dropped the
            # back-half of long CVs and contracts where employment
            # durations and clauses tend to live). The total prompt
            # stays bounded by candidate count × chunks-per-candidate
            # × token target, all already enforced upstream.
            rendered += f"\n    [{i}] {chunk}"
    return f"- Dokument {c.get('id')}:\n{rendered}\n"


def _to_json(d: dict) -> str:
    """Used by tests asserting that example output is valid JSON."""
    return json.dumps(d, ensure_ascii=False)


def build_streaming_answer_messages(
    question: str,
    *,
    candidates: list[dict],
    chunks_by_doc: dict[int, list[str]] | None = None,
) -> list[dict]:
    """Variant of `build_answer_messages` for the SSE streaming path.

    Same candidate context, but the prompt asks for prose only (no JSON
    envelope) and cites with `[Quelle: <id>]` markers we can regex out
    server-side. JSON-mode would block streaming until the whole document
    is decoded, defeating the point.

    `chunks_by_doc` is the new RAG hook (Phase 1.9): for each candidate
    doc id, the top reranked text chunks from Qdrant. When provided,
    each candidate's prompt block carries its chunks under
    "Relevante Auszüge:" — that's where the answer LLM finds answers
    that aren't in the AI metadata fields (CV employment durations,
    contract clauses, table cells, etc.). When None or empty, the
    prompt falls back to the structural-only AI-metadata path so a
    deployment without Qdrant still works.
    """
    return [
        {
            "role": "system",
            "content": _streaming_system_prompt(candidates=candidates),
        },
        {
            "role": "user",
            "content": _streaming_user_prompt(
                question, candidates, chunks_by_doc=chunks_by_doc or {}
            ),
        },
    ]


def _streaming_system_prompt(*, candidates: list[dict]) -> str:
    parts: list[str] = []
    parts.append(
        "Du bist ein Assistent für ein persönliches Dokumenten-System. "
        "Beantworte die Frage des Nutzers AUSSCHLIESSLICH auf Basis der "
        "bereitgestellten Dokumente. Wenn die Antwort nicht in den Dokumenten "
        "steht, sage das ehrlich."
    )
    parts.append("Regeln:")
    parts.append("- Antworte auf Deutsch.")
    parts.append("- Halte die Antwort kurz: höchstens 3 Sätze.")
    parts.append(
        "- KEIN JSON. Antworte direkt im Fließtext — die Antwort wird "
        "Zeichen-für-Zeichen an den Nutzer gestreamt."
    )
    parts.append(
        "- Zitiere jedes verwendete Dokument inline mit '[Quelle: <id>]', "
        "z. B. 'Dein Pass läuft am 12.05.2030 ab. [Quelle: 17]'. Nutze nur "
        "IDs aus der unten gelisteten Liste; erfinde keine."
    )
    parts.append(
        "- Wenn keines der Dokumente die Frage beantwortet, antworte kurz "
        "'Ich konnte das in den Dokumenten nicht finden.' ohne Quelle."
    )
    parts.append(f"- Heute ist {date.today().isoformat()}.")
    parts.append("")
    parts.extend(_assembled_field_hints(candidates))
    parts.append(
        "- Wenn nach dem Gesamtbetrag über mehrere Dokumente gefragt wird "
        "('wie viel habe ich bei X ausgegeben', 'Gesamtausgaben'), "
        "addiere die Gesamtbeträge aller relevanten Dokumente und nenne die Summe. "
        "Liste auch die Einzelbeträge auf."
    )
    return "\n".join(parts)


# Citation-format examples kept static across calls — they teach the inline
# `[Quelle: N]` syntax and the cross-doc aggregation shape; both are
# orthogonal to per-type field guidance. Per-type examples are appended on
# top via `_assembled_examples`.
_STATIC_AGGREGATION_EXAMPLE = (
    "Frage: 'Wie viel habe ich bei Wizz Air ausgegeben?'\n"
    "3 Dokumente mit Gesamtbetrag: EUR676.50, EUR55.00, EUR45.00\n"
    "→ 'Du hast insgesamt 776,50 € bei Wizz Air ausgegeben "
    "(676,50 € + 55,00 € + 45,00 €). [Quelle: 109, 132, 133]'"
)


def _streaming_user_prompt(
    question: str,
    candidates: list[dict],
    *,
    chunks_by_doc: dict[int, list[str]] | None = None,
) -> str:
    parts: list[str] = []
    parts.append("Beispiele für korrektes Format:")
    for example in _assembled_examples(candidates, json_mode=False):
        parts.append(example)
    parts.append(_STATIC_AGGREGATION_EXAMPLE)
    parts.append("")
    parts.append(f"Frage: {question}")
    parts.append("")
    parts.append("Verfügbare Dokumente:")
    if not candidates:
        parts.append("(keine)")
    else:
        for c in candidates:
            parts.append(
                _render_candidate(c, chunks=(chunks_by_doc or {}).get(c.get("id"), []))
            )
    parts.append("")
    parts.append("Schreibe jetzt die Antwort:")
    return "\n".join(parts)
