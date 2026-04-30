"""German prompt builder for /api/ai/ask.

The prompt is a system message + a user message. The system message inlines:

  1. Role + JSON-only output rule.
  2. The 20-value DocumentType taxonomy with one-line German definitions.
  3. The live correspondent list (capped at 200 names).
  4. Date-parsing rules with explicit examples.
  5. Amount-parsing rules.
  6. Four few-shot exemplars covering the main query shapes.

Pure function — no I/O, no settings dependency. The caller is responsible
for fetching the live correspondent list (typically via the gateway cache).
"""

from __future__ import annotations

from datetime import date

# Order matches DocumentType so the prompt enumerates every enum value. The
# auto-tagger keeps a richer set of definitions for classification; we keep a
# tighter version here because the search task only needs disambiguation, not
# extraction guidance.
_DOC_TYPE_HINTS: dict[str, str] = {
    "Rechnung": "Rechnungen, Quittungen, Kaufbelege",
    "Gehaltsabrechnung": "Lohn-/Gehaltsabrechnungen, Bezügemitteilungen",
    "Kontoauszug": "Bank-, Kreditkarten-, Sparkontoauszüge",
    "Nebenkostenabrechnung": "Heiz-, Wasser-, Wohnnebenkosten",
    "Mahnung": "Zahlungserinnerungen, Inkasso",
    "Vertrag": "Mietvertrag, Arbeitsvertrag, Service-Vertrag",
    "Kündigung": "Kündigungsschreiben jeder Art",
    "Versicherung": "Versicherungspolicen, -bescheinigungen",
    "Steuer": "Steuerbescheid, Steuererklärung, Steuerformular",
    "Bescheid": "Behördenbescheide nicht-steuerlicher Art",
    "Behördenbrief": "Sonstige Behördenkorrespondenz",
    "Kfz": "Fahrzeugschein, Zulassung, TÜV-Bericht",
    "Arztbrief": "Arztberichte, Befunde, Rezepte",
    "Garantie": "Garantieurkunden, Gewährleistungen",
    "Urkunde": "Geburts-, Heirats-, Sterbeurkunden",
    "Ausweis": "Personalausweis, Reisepass, Führerschein",
    "Zeugnis": "Schul-, Hochschulzeugnisse",
    "Arbeitszeugnis": "Arbeits- und Praktikumszeugnisse",
    "Mitgliedschaft": "Mitgliedsbescheinigungen, Vereinsausweise",
    "Sonstiges": "Alles andere ohne klare Kategorie",
}

_MAX_CORRESPONDENTS = 200

# Few-shot exemplars. Kept short; each one demonstrates one or two filter shapes.
# When tweaking, keep the count ≥4 — the test suite asserts this.
_FEW_SHOT_EXAMPLES: list[tuple[str, dict]] = [
    (
        "Lohnabrechnungen aus 2023 über 3000€",
        {
            "document_type": "Gehaltsabrechnung",
            "date_from": "2023-01-01",
            "date_to": "2023-12-31",
            "min_amount": 3000,
        },
    ),
    (
        "Rechnungen von Telekom",
        {"document_type": "Rechnung", "correspondent": "Telekom"},
    ),
    (
        "Verträge im ersten Quartal 2024",
        {
            "document_type": "Vertrag",
            "date_from": "2024-01-01",
            "date_to": "2024-03-31",
        },
    ),
    (
        "Steuerbescheide unter 100 Euro",
        {"document_type": "Steuer", "max_amount": 100},
    ),
]


def build_messages(query: str, *, correspondents: list[str]) -> list[dict]:
    """Return a list[{role, content}] pair: system + user.

    `correspondents` is the live list of known names; capped at 200 inline.
    """
    system = _build_system_prompt(correspondents=correspondents)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": query},
    ]


def _build_system_prompt(*, correspondents: list[str]) -> str:
    parts: list[str] = []
    parts.append(
        "Du bist ein Suchassistent für ein deutsches Dokumentenmanagementsystem. "
        "Deine Aufgabe: eine deutschsprachige Suchanfrage in einen strukturierten Filter "
        "übersetzen. Antworte ausschließlich mit gültigem JSON nach dem vorgegebenen Schema."
    )
    parts.append("Dokumenttypen (genau einer aus dieser Liste oder null):")
    for name, hint in _DOC_TYPE_HINTS.items():
        parts.append(f"- {name}: {hint}")

    parts.append("Bekannte Korrespondenten (nutze einen exakten Namen oder null):")
    truncated = correspondents[:_MAX_CORRESPONDENTS]
    parts.append(", ".join(truncated) if truncated else "(keine bekannt)")

    parts.append("Datumsregeln:")
    parts.append("- 'aus 2023' → date_from=2023-01-01, date_to=2023-12-31")
    parts.append("- 'Januar 2024' → date_from=2024-01-01, date_to=2024-01-31")
    parts.append("- 'Q1 2024' → date_from=2024-01-01, date_to=2024-03-31")
    parts.append("- 'letzten Monat' / 'aktueller Monat' → relativ zu heute interpretieren")
    parts.append(f"- Heute ist {date.today().isoformat()}")

    parts.append("Betragsregeln:")
    parts.append("- 'über 3000€' / 'mehr als 3000 Euro' → min_amount=3000")
    parts.append("- 'unter 100€' / 'weniger als 100 EUR' → max_amount=100")
    parts.append("- 'zwischen 50 und 200€' → min_amount=50, max_amount=200")

    parts.append(
        "Freitextregel: Begriffe ohne strukturelle Bedeutung (Stichworte, "
        "Inhaltsfragmente) gehören in das Feld `text`."
    )

    parts.append("Beispiele:")
    for q, f in _FEW_SHOT_EXAMPLES:
        parts.append(f"Beispiel: Anfrage='{q}' → {_format_filter_example(f)}")

    return "\n".join(parts)


def _format_filter_example(f: dict) -> str:
    import json

    return json.dumps(f, ensure_ascii=False)
