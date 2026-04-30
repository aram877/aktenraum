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


def build_answer_messages(question: str, *, candidates: list[dict]) -> list[dict]:
    """Return [system, user] messages for the answer LLM call.

    `candidates` shape (each item):
        {
          "id": int, "title": str, "correspondent": str|None,
          "document_type": str|None, "created": "YYYY-MM-DD"|None,
          "ai_summary_de": str|None, "ai_issue_date": str|None,
          "ai_due_date": str|None, "ai_expiry_date": str|None,
          "ai_monetary_amount": str|None, "ai_reference_numbers": str|None,
        }
    """
    system = _system_prompt()
    user = _user_prompt(question, candidates)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _system_prompt() -> str:
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
    parts.append("Feld-Hinweise (wichtig — nutze diese Felder direkt!):")
    parts.append(
        "- Fragen wie 'Wann läuft … ab?', 'Wann muss ich … verlängern?', "
        "'Bis wann ist … gültig?' werden durch das Feld 'Ablauf' beantwortet."
    )
    parts.append(
        "- Fragen nach Ausstellungsdatum / 'wann ausgestellt' → Feld 'Ausstellung'."
    )
    parts.append(
        "- Fragen nach Fälligkeit ('bis wann zahlen?') → Feld 'Fällig'."
    )
    parts.append(
        "- Fragen nach Beträgen ('wieviel', 'kosten') → Feld 'Betrag'."
    )
    parts.append(
        "- Wenn ein passendes Feld bereits einen Wert hat, IST das die Antwort. "
        "Sage NICHT 'keine Information', wenn das Feld gefüllt ist."
    )
    return "\n".join(parts)


def _user_prompt(question: str, candidates: list[dict]) -> str:
    parts: list[str] = []
    parts.append("Beispiele wie du Felder verwendest:")
    parts.append(
        "  Frage: 'Wann läuft mein Pass ab?'"
        "  Dokument hat Ablauf: 2030-05-12"
        '  → {"answer_de": "Dein Pass läuft am 12.05.2030 ab.", "cited_ids": [<id>]}'
    )
    parts.append(
        "  Frage: 'Was hat die Stromrechnung gekostet?'"
        "  Dokument hat Betrag: EUR149.99"
        '  → {"answer_de": "Die Stromrechnung betrug 149,99 €.", "cited_ids": [<id>]}'
    )
    parts.append(
        "  Frage: 'Bis wann muss ich zahlen?'"
        "  Dokument hat Fällig: 2024-12-31"
        '  → {"answer_de": "Du musst bis zum 31.12.2024 zahlen.", "cited_ids": [<id>]}'
    )
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


def _render_candidate(c: dict) -> str:
    """Compact one-block representation per candidate.

    Skipping null fields keeps the prompt small and avoids confusing the LLM
    with empty values it might try to reason about.
    """
    fields: list[tuple[str, str | int | None]] = [
        ("ID", c.get("id")),
        ("Titel", c.get("title")),
        ("Typ", c.get("document_type")),
        ("Korrespondent", c.get("correspondent")),
        ("Eingangsdatum", c.get("created")),
        ("Ausstellung", c.get("ai_issue_date")),
        ("Fällig", c.get("ai_due_date")),
        ("Ablauf", c.get("ai_expiry_date")),
        ("Betrag", c.get("ai_monetary_amount")),
        ("Referenzen", c.get("ai_reference_numbers")),
    ]
    rendered = "\n".join(
        f"  {label}: {value}" for label, value in fields if value not in (None, "")
    )
    summary = c.get("ai_summary_de")
    if summary:
        rendered += f"\n  Zusammenfassung: {summary}"
    return f"- Dokument {c.get('id')}:\n{rendered}\n"


def _to_json(d: dict) -> str:
    """Used by tests asserting that example output is valid JSON."""
    return json.dumps(d, ensure_ascii=False)
