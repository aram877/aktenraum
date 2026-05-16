"""German prompt builder for /api/ai/ask.

The prompt is a system message + a user message. The system message inlines:

  1. Role + JSON-only output rule.
  2. The DocumentType taxonomy with one-line German definitions.
  3. The live correspondent list (capped at 200 names).
  4. Date-parsing rules with explicit examples.
  5. Few-shot exemplars covering the main query shapes.

Pure function — no I/O, no settings dependency. The caller is responsible
for fetching the live correspondent list (typically via the gateway cache).

Amount-based filtering was removed when the generic `monetary_amount`
field was retired. Queries like "über 3000 €" now land in `text` (or
get routed via tags / per-type fields outside this prompt).
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
    "Nebenkostenabrechnung": "Mieter-seitige Nebenkostenabrechnung",
    "Hausgeldabrechnung": "Eigentümer-seitige WEG-Jahresabrechnung",
    "Mahnung": "Zahlungserinnerungen, Inkasso",
    "Vertrag": "Mietvertrag, Arbeitsvertrag, Service-Vertrag",
    "Kündigung": "Kündigungsschreiben jeder Art",
    "Versicherung": "Versicherungspolicen, -bescheinigungen",
    "Steuer": "Steuererklärungen, Steuerformulare, Anlagen — NICHT Lohnsteuerbescheinigung",
    "Lohnsteuerbescheinigung": "Jährliche Lohnsteuerbescheinigung (§41b EStG)",
    "Spendenbescheinigung": "Zuwendungsbestätigung (§50 EStDV)",
    "Bescheid": "Behördenbescheide nicht-steuerlicher Art (außer Bußgeld)",
    "Behördenbrief": "Sonstige Behördenkorrespondenz (inkl. Einwohnermeldebescheinigung)",
    "Sozialversicherungsmeldung": "Meldebescheinigung zur Sozialversicherung / SV-Jahresmeldung",
    "Kfz": "Fahrzeugschein, Zulassung, TÜV-Bericht",
    "Bußgeldbescheid": "Bußgeld-/Verwarngeldbescheid wegen Verkehrsverstoß",
    "Arztbrief": "Arztberichte, Befunde, Rezepte",
    "Krankschreibung": "AU-Bescheinigung / gelber Schein",
    "Garantie": "Garantieurkunden, Gewährleistungen",
    "Urkunde": "Geburts-, Heirats-, Sterbeurkunden",
    "Ausweis": "Personalausweis, Reisepass, Führerschein",
    "Zeugnis": "Schul-, Hochschulzeugnisse",
    "Arbeitszeugnis": "Arbeits- und Praktikumszeugnisse",
    "Mitgliedschaft": "Mitgliedsbescheinigungen, Vereinsausweise",
    "Sonstiges": "Alles andere ohne klare Kategorie",
}

_MAX_CORRESPONDENTS = 200
_MAX_TAGS = 200

# Few-shot exemplars. Kept short; each one demonstrates one or two filter shapes.
# When tweaking, keep the count ≥4 — the test suite asserts this.
_FEW_SHOT_EXAMPLES: list[tuple[str, dict]] = [
    (
        "Lohnabrechnungen aus 2023",
        {
            "document_type": "Gehaltsabrechnung",
            "date_from": "2023-01-01",
            "date_to": "2023-12-31",
        },
    ),
    (
        "Wie viel habe ich in 2025 verdient?",
        {
            "document_type": "Gehaltsabrechnung",
            "date_from": "2025-01-01",
            "date_to": "2025-12-31",
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
        "Steuerbescheide aus 2023",
        {
            "document_type": "Steuer",
            "date_from": "2023-01-01",
            "date_to": "2023-12-31",
        },
    ),
    # Tag-driven query: doc_type alone is unreliable for things like
    # "Lebenslauf" (often misclassified as Arbeitszeugnis), so prefer the tag.
    (
        "Mein Lebenslauf",
        {"tags": ["Lebenslauf"]},
    ),
]


def build_messages(
    query: str,
    *,
    correspondents: list[str],
    tags: list[str] | None = None,
) -> list[dict]:
    """Return a list[{role, content}] pair: system + user.

    `correspondents` is the live list of known names; capped at 200 inline.
    `tags` is the live tag vocabulary (cap 200); pass `None` (or empty) to
    omit the section entirely.
    """
    system = _build_system_prompt(correspondents=correspondents, tags=tags or [])
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": query},
    ]


def _build_system_prompt(*, correspondents: list[str], tags: list[str]) -> str:
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

    parts.append(
        "Bekannte Tags (frei wählbar, mehrere möglich; Liste leer lassen wenn "
        "keiner passt). Tags helfen besonders, wenn der Dokumenttyp unklar ist "
        "(z. B. ein Lebenslauf wird oft als 'Arbeitszeugnis' erkannt — der Tag "
        "'Lebenslauf' ist dann zuverlässiger):"
    )
    truncated_tags = tags[:_MAX_TAGS]
    parts.append(", ".join(truncated_tags) if truncated_tags else "(keine bekannt)")

    parts.append("Datumsregeln:")
    parts.append("- 'aus 2023' → date_from=2023-01-01, date_to=2023-12-31")
    parts.append("- 'Januar 2024' → date_from=2024-01-01, date_to=2024-01-31")
    parts.append("- 'Q1 2024' → date_from=2024-01-01, date_to=2024-03-31")
    parts.append("- 'letzten Monat' / 'aktueller Monat' → relativ zu heute interpretieren")
    parts.append(f"- Heute ist {date.today().isoformat()}")

    parts.append(
        "Hinweis zu Beträgen: Dieser Filter hat KEINE betragsbezogenen Felder. "
        "Beträge in der Anfrage (z. B. 'über 3000 €') ggf. als Freitext in `text` "
        "aufnehmen oder ignorieren. Bevorzuge typspezifische Felder zur "
        "späteren Verfeinerung über das UI."
    )

    parts.append(
        "Freitextregel: Begriffe ohne strukturelle Bedeutung (Stichworte, "
        "Inhaltsfragmente) gehören in das Feld `text`. Bevorzuge passende Tags "
        "gegenüber Freitext."
    )

    parts.append("Beispiele:")
    for q, f in _FEW_SHOT_EXAMPLES:
        parts.append(f"Beispiel: Anfrage='{q}' → {_format_filter_example(f)}")

    return "\n".join(parts)


def _format_filter_example(f: dict) -> str:
    import json

    return json.dumps(f, ensure_ascii=False)
