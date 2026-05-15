import json
from datetime import date
from typing import Any

import aiohttp
import structlog
from aktenraum_core.llm import LLMBackend, extract_type_specific
from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentExtraction, DocumentType
from aktenraum_core.paperless import PaperlessClient

from .config import Settings

_GERMAN_MONTHS = (
    "",  # 1-indexed
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
)


def _format_issue_date_de(raw: str | None) -> str | None:
    """Render an ISO date as a German "Monat Jahr" string for display titles.

    Returns None when the input isn't parseable so callers can fall back to
    the doc_type + correspondent shape without a stray "None" leaking in.
    """
    if not raw:
        return None
    try:
        parsed = date.fromisoformat(raw[:10])
    except ValueError:
        return None
    return f"{_GERMAN_MONTHS[parsed.month]} {parsed.year}"


def _format_error(label: str, exc: BaseException) -> str:
    """Build a compact, user-facing error string for the ai_error_message field.

    Format: "{Label} – {ExceptionClass}: {message}". Capped at 2000 chars so a
    runaway traceback can't blow the Paperless DB column, but well above the
    128-char string-field limit (the field is `longtext`). Keep the prefix
    German to match the rest of the SPA — the user reads this directly.
    """
    cls = type(exc).__name__
    msg = str(exc).strip() or repr(exc)
    out = f"{label} – {cls}: {msg}"
    if len(out) > 2000:
        out = out[:1997] + "…"
    return out


def _synthesize_ai_title(extraction: DocumentExtraction) -> str:
    """Build a sensible Paperless-displayable title from the structured fields.

    Used as a safety net when the LLM either returns null/empty for `ai_title`
    or hallucinates something useless. The result is "<DocType> · <Correspondent>
    · <Monat Jahr>" with the optional parts dropped when absent — guaranteed
    non-empty because `document_type` is required on `DocumentExtraction`.
    """
    parts: list[str] = [extraction.document_type.value]
    if extraction.correspondent:
        parts.append(extraction.correspondent.strip())
    date_part = _format_issue_date_de(extraction.key_dates.issue)
    if date_part:
        parts.append(date_part)
    return " · ".join(parts)

log = structlog.get_logger()

SYSTEM_PROMPT = """\
Du bist ein Assistent zur automatischen Klassifikation und Extraktion von deutschen Dokumenten.

Du erhältst den OCR-Text eines gescannten Dokuments und extrahierst daraus strukturierte Metadaten.

Wähle den document_type anhand dieser Definitionen — nimm immer den spezifischsten passenden Typ:

- Rechnung: Rechnungen, Quittungen, Kaufbelege für Waren oder Dienstleistungen (nicht von Versicherungen oder Behörden)
- Gehaltsabrechnung: Lohnabrechnung, Gehaltszettel, Brutto-Netto-Abrechnung, Bezügemitteilung, Rentenabrechnung
- Kontoauszug: Bank-, Kreditkarten-, Depot- und Sparkontoauszüge
- Nebenkostenabrechnung: Betriebskostenabrechnung, Jahresabrechnung für Strom, Gas, Wasser, Heizung — Mieter-seitige Nebenkostenabrechnung. NICHT: Hausgeldabrechnung (siehe unten, Eigentümer-seitig).
- Hausgeldabrechnung: Jahresabrechnung der Wohnungseigentümergemeinschaft (WEG) — Eigentümer-seitig, vom Hausverwalter ausgestellt. Typische Inhalte: Wirtschaftsjahr, Hausgeldanteil, Instandhaltungsrücklage, Nachzahlung/Guthaben, Hausverwaltung. Aliasnamen: WEG-Abrechnung. NICHT verwechseln mit: Nebenkostenabrechnung (Mieter-seitig), Wohngeldbescheid (Sozialleistung → Bescheid).
- Mahnung: Zahlungserinnerungen, Mahnbescheide, Inkassoschreiben, Vollstreckungsbescheide
- Vertrag: Arbeitsvertrag, Mietvertrag, Kaufvertrag, Dienstleistungsvertrag, Darlehensvertrag, Vereinbarungen
- Kündigung: Kündigungsschreiben und Widerruf von Verträgen, Abonnements oder Mitgliedschaften
- Versicherung: Versicherungspolicen, Versicherungsnachweise, Deckungsbestätigungen, Schadensregulierung
- Steuer: Steuererklärungen, Steuerformulare (Anlage N, V, KAP etc.), Steuer-Bescheinigungen (NICHT die Lohnsteuerbescheinigung — die hat einen eigenen Typ).
- Lohnsteuerbescheinigung: vom Arbeitgeber jährlich ausgestellte "Ausdruck der Elektronischen Lohnsteuerbescheinigung" / "Besondere Lohnsteuerbescheinigung" (§41b EStG). Aliasnamen: Lohnsteuerabrechnung, Jahreslohnzettel. Typische Inhalte: Bescheinigungszeitraum (Jahr), Steueridentifikationsnummer, Steuerklasse, Brutto-Arbeitslohn (Zeile 3), einbehaltene Lohnsteuer (Zeile 4), Solidaritätszuschlag, Kirchensteuer, zuständiges Finanzamt. NICHT verwechseln mit: Gehaltsabrechnung (monatlich), Steuerbescheid (vom Finanzamt → Bescheid), Sozialversicherungsmeldung (DEÜV-Meldung des Arbeitgebers).
- Spendenbescheinigung: Zuwendungsbestätigung nach §50 EStDV — von einer als gemeinnützig anerkannten Organisation für eine erhaltene Spende ausgestellt, dient als Beleg für die Steuererklärung. Aliasnamen: Zuwendungsbestätigung. Typische Inhalte: Empfängerorganisation, Spendendatum, Spendenbetrag, Verwendungszweck, Anerkennung der Steuerbegünstigung. NICHT verwechseln mit: Rechnung (echter Kauf/Leistung), Mitgliedschaft (Vereinsmitgliedschaft), Steuer (eigene Steuererklärung).
- Bescheid: Amtliche Bescheide mit Rechtswirkung — Steuerbescheid, Rentenbescheid, BAföG-Bescheid, Bewilligungs- oder Ablehnungsbescheid (NICHT: Bußgeldbescheid → eigener Typ)
- Behördenbrief: Amtliche Schreiben ohne Bescheidcharakter — Informationsschreiben, Antragsbestätigungen, Einwohnermeldebescheinigung (Bestätigung des Wohnsitzes vom Bürgeramt). NICHT: Meldebescheinigung zur Sozialversicherung (siehe Sozialversicherungsmeldung).
- Sozialversicherungsmeldung: Meldebescheinigung zur Sozialversicherung / Jahresmeldung zur Sozialversicherung / SV-Meldung / Meldung nach DEÜV — vom Arbeitgeber jährlich (oder bei Beschäftigungsende) ausgestellt. Typisch: Beitragszeitraum, Brutto-Arbeitsentgelt, beitragspflichtiges Entgelt, Sozialversicherungsnummer (RV-Nr.), Betriebsnummer. NICHT verwechseln mit: Gehaltsabrechnung (monatlich), Lohnsteuerbescheinigung (→ Steuer), oder Einwohnermeldebescheinigung (→ Behördenbrief).
- Kfz: Fahrzeugschein, Fahrzeugbrief, Zulassungsbescheinigung, TÜV-/HU-Bericht, Kfz-Steuer. NICHT: Bußgeldbescheid (eigener Typ).
- Bussgeldbescheid: Bußgeld- oder Verwarngeldbescheid (auch Anhörungsbogen) wegen Verkehrsverstoß. Typische Inhalte: Tatzeit/Tatort, Kennzeichen, Tatbestand, Bußgeld/Verwarngeld, Punkte in Flensburg, Einspruchsfrist. Aliasnamen: Verwarnung, Verkehrsbescheid. NICHT verwechseln mit: Kfz-Dokumenten (Zulassung, TÜV), Steuerbescheid → Bescheid.
- Arztbrief: längere ärztliche Berichte, Befundbriefe, Laborbefunde, Überweisungen, Rezepte, Krankenhausentlassungsberichte, Impfnachweise. NICHT: kurze Arbeitsunfähigkeitsbescheinigung → Krankschreibung.
- Krankschreibung: Arbeitsunfähigkeitsbescheinigung (AU-Bescheinigung, "gelber Schein") — kurzes Formular mit Zeitraum, das dem Arbeitgeber vorgelegt wird. Typische Inhalte: AU-Zeitraum von/bis, Erst- oder Folgebescheinigung, Arzt/Praxis, ggf. ICD-10-Code. Aliasnamen: AU-Bescheinigung, Arbeitsunfähigkeitsbescheinigung, gelber Schein. NICHT verwechseln mit: Arztbrief (ausführlicher Bericht), Rezept.
- Garantie: Garantieurkunden, Gewährleistungsnachweise, Garantiezertifikate für Geräte oder Produkte
- Urkunde: Geburtsurkunde, Heiratsurkunde, Sterbeurkunde, Apostille, notarielle Urkunden
- Ausweis: Scans von Personalausweis, Reisepass, Führerschein, Krankenversicherungskarte, Schwerbehindertenausweis
- Zeugnis: Schulzeugnisse, Hochschulabschlüsse, Ausbildungszeugnisse, Sprachzertifikate (z.B. TELC, Goethe)
- Arbeitszeugnis: Arbeitszeugnisse, Zwischenzeugnisse, Referenzschreiben von Arbeitgebern
- Mitgliedschaft: GEZ/ARD-ZDF-Beitrag, Vereinsbeitrag, Gewerkschaft, ADAC, Fitnessstudio, Streaming-Abonnements
- Sonstiges: Nur wenn kein anderer Typ passt (z.B. Lebenslauf, interne Notizen, Fotos)

Weitere Regeln:
- Datumsangaben immer im Format YYYY-MM-DD. OCR fragmentiert oft Ziffern mit Leerzeichen, z.B. "2 8. 0 2.24" oder "28. 0 2 . 2024" — interpretiere solche Muster trotzdem als Datum (28.02.2024). Bei zweistelligen Jahreszahlen ergänze sinnvoll: 24 → 2024, 87 → 1987 (laut Kontext).
- key_dates.issue: das Datum, an dem dieses Dokument selbst ausgestellt/datiert wurde (z.B. Rechnungsdatum, Bescheiddatum, Vertragsabschluss, Ausstellungsdatum eines Ausweises — typischerweise neben "Datum:", "Ausgestellt am:", "vom"). NICHT verwenden für: Geburtsdaten, Beschäftigungs- oder Studienzeiträume, im Inhalt erwähnte Termine, Mietbeginn, Reisedaten o.Ä. Wenn das Dokument kein eigenes Ausstellungsdatum trägt (z.B. Lebenslauf, Notiz, Foto): null
- correspondent: bei amtlichen Dokumenten die ausstellende Behörde/Authority (z.B. "STADT BIELEFELD", "Finanzamt Köln"); bei Rechnungen das Unternehmen, das die Rechnung schickt; bei Verträgen die Gegenpartei. Auch dieser Wert kann durch OCR-Fragmentierung verunreinigt sein — normalisiere Leerzeichen.
- ai_title: PFLICHTFELD. Gib IMMER einen prägnanten, sprechenden deutschen Titel zurück, sobald document_type erkennbar ist (~5–8 Wörter). Format: "{Dokumenttyp} {Korrespondent} {Monat/Jahr oder Stichwort}". Verwende den deutschen Monatsnamen, wenn ein Ausstellungsdatum existiert. Nur als allerletzten Ausweg null (z.B. unleserlicher Scan ohne erkennbaren Inhalt). Vorlagen pro Typ:
  • Rechnung: "Rechnung {Firma} {Monat Jahr}" — z.B. "Rechnung Stadtwerke München März 2024"
  • Gehaltsabrechnung: "Gehaltsabrechnung {Arbeitgeber} {Monat Jahr}" — z.B. "Gehaltsabrechnung Acme GmbH November 2024"
  • Kontoauszug: "Kontoauszug {Bank} {Monat Jahr}" — z.B. "Kontoauszug Sparkasse Köln Februar 2024"
  • Nebenkostenabrechnung: "Nebenkostenabrechnung {Vermieter/Hausverwaltung} {Jahr}" — z.B. "Nebenkostenabrechnung Mustermann Immobilien 2023"
  • Hausgeldabrechnung: "Hausgeldabrechnung {Hausverwaltung} {Jahr}" — z.B. "Hausgeldabrechnung Müller WEG-Verwaltung 2023"
  • Mahnung: "Mahnung {Firma} {Rechnungsnr. oder Monat Jahr}" — z.B. "Mahnung Telekom Rechnung 12345"
  • Vertrag: "{Vertragsart} {Gegenpartei}" — z.B. "Arbeitsvertrag Acme GmbH" oder "Mietvertrag Schiller-Str. 12"
  • Kündigung: "Kündigung {Vertragsart} {Gegenpartei}" — z.B. "Kündigung Fitnessstudio McFit"
  • Versicherung: "{Versicherungsart} {Versicherer} {Jahr}" — z.B. "Hausratversicherung Allianz 2024"
  • Steuer: "{Dokumenttitel} {Jahr} {Finanzamt}" — z.B. "Steuererklärung 2023 Finanzamt Köln"
  • Lohnsteuerbescheinigung: "Lohnsteuerbescheinigung {Arbeitgeber} {Jahr}" — z.B. "Lohnsteuerbescheinigung Acme GmbH 2024"
  • Spendenbescheinigung: "Spendenbescheinigung {Empfänger} {Jahr}" — z.B. "Spendenbescheinigung Ärzte ohne Grenzen 2024"
  • Bescheid: "{Bescheidtitel} {Behörde} {Datum/Jahr}" — z.B. "Rentenbescheid Deutsche Rentenversicherung 2024"
  • Behördenbrief: "{Behörde} – {Stichwort} {Datum}" — z.B. "Bürgeramt München – Meldebescheinigung 2024"
  • Sozialversicherungsmeldung: "SV-Meldung {Arbeitgeber} {Jahr}" — z.B. "SV-Meldung Acme GmbH 2024"
  • Kfz: "{Dokumenttitel} {Kennzeichen oder Marke}" — z.B. "Zulassungsbescheinigung K-AB-123" oder "TÜV-Bericht VW Golf"
  • Bussgeldbescheid: "Bußgeldbescheid {Kennzeichen oder Behörde} {Datum}" — z.B. "Bußgeldbescheid K-AB-123 März 2024"
  • Arztbrief: "Arztbrief {Facharzt/Praxis} {Datum}" — z.B. "Arztbrief Dr. Müller März 2024"
  • Krankschreibung: "Krankschreibung {Arzt} {Zeitraum}" — z.B. "Krankschreibung Dr. Müller 12.–19.03.2024"
  • Garantie: "Garantie {Produkt} {Marke}" — z.B. "Garantie Waschmaschine Bosch"
  • Urkunde: "{Urkundenart} {Name oder Datum}" — z.B. "Geburtsurkunde Max Mustermann"
  • Ausweis: "{Ausweisart} {Inhabername}" — z.B. "Personalausweis Max Mustermann"
  • Zeugnis: "{Zeugnisart} {Institution} {Jahr}" — z.B. "Abiturzeugnis Goethe-Gymnasium 2020"
  • Arbeitszeugnis: "Arbeitszeugnis {Arbeitgeber} {Zeitraum}" — z.B. "Arbeitszeugnis Acme GmbH 2020–2024"
  • Mitgliedschaft: "{Organisation} Mitgliedschaft {Jahr}" — z.B. "ADAC Mitgliedschaft 2024"
  • Sonstiges: kurze inhaltliche Beschreibung — z.B. "Lebenslauf Max Mustermann" oder "Foto Reisepass"
- Geldbeträge gehören NICHT in das generische Schema. Werte zu Beträgen, Gebühren, Bruttosummen, Nettosummen, Rückerstattungen, Forderungen, Prämien, Beiträgen etc. werden im typspezifischen Schritt (Pass 2) erfasst, falls der Dokumenttyp passende Felder vorsieht (z.B. Rechnung → gesamtbetrag, Mahnung → forderungsbetrag, Steuer → erstattung). Im hier vorliegenden Schritt KEINEN Geldbetrag ausgeben.
- summary_de muss genau 3 Sätze auf Deutsch enthalten
- confidence gibt an, wie sicher du dir bei der Extraktion bist (0.0 = unsicher, 1.0 = sehr sicher)
- ai_title NIE leer lassen, wenn document_type erkennbar ist — synthetisiere notfalls aus document_type + correspondent + Datum.
- Bei nicht-ermittelbaren Skalar-Feldern (correspondent, key_dates.*): null
- Bei nicht-ermittelbaren Listen-Feldern (reference_numbers, suggested_tags): leere Liste []
"""

_MAX_CHARS_PER_TOKEN = 4
_TRUNCATION_NOTICE = "\n\n[Dokument wurde aufgrund der Länge gekürzt.]"
_FEW_SHOT_TEXT_LIMIT = 1500


def _truncate_text(text: str, max_tokens: int) -> str:
    max_chars = max_tokens * _MAX_CHARS_PER_TOKEN
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + _TRUNCATION_NOTICE


def _split_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def _example_payload(
    ai_fields: dict[str, Any],
    *,
    correspondent_name: str | None,
    document_type_name: str | None,
    created_date: str | None,
    tag_names: list[str],
) -> str:
    """Render a vetted Paperless extraction back as a DocumentExtraction-shaped JSON.

    Native Paperless fields (correspondent, document_type, created_date, tags)
    take priority over the ai_* custom fields where they exist — those are
    the user's ground truth post-propagation. The ai_* fields fill in the
    columns Paperless has no native equivalent for (summary, reference
    numbers, ai_title). Monetary values intentionally absent — they are
    captured by Pass 2 (type-specific schemas) only.
    """
    payload = {
        "document_type": document_type_name or ai_fields.get("ai_document_type"),
        "correspondent": correspondent_name or ai_fields.get("ai_correspondent"),
        "ai_title": ai_fields.get("ai_title"),
        "key_dates": {
            "issue": created_date or ai_fields.get("ai_issue_date"),
        },
        "reference_numbers": _split_csv(ai_fields.get("ai_reference_numbers")),
        "suggested_tags": tag_names or _split_csv(ai_fields.get("ai_suggested_tags")),
        "summary_de": ai_fields.get("ai_summary_de") or "",
        "confidence": ai_fields.get("ai_confidence", 1.0),
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


_LIFECYCLE_TAG_NAMES = {
    "ai-pending",
    "ai-approved",
    "ai-auto-approved",
    "ai-rejected",
    "ai-propagated",
    "ai-propagation-error",
    "ai-error",
    "ai-low-confidence",
}


async def _build_few_shot_block(paperless: PaperlessClient, n: int) -> str:
    """Pull N most-recently-propagated docs and render a few-shot block.

    Examples reflect the user-vetted native Paperless state (correspondent,
    document_type, created_date, native tags) rather than the original AI
    extraction stored in custom fields. So any correction the user makes —
    pre-approval (in ai_* fields) or post-propagation (on native fields) —
    feeds back into future extractions.
    """
    if n <= 0:
        return ""
    docs = await paperless.get_documents_with_tag(
        "ai-propagated", batch_size=n, ordering="-modified"
    )
    if not docs:
        return ""
    name_by_id = await paperless.get_custom_field_name_by_id()
    correspondent_names = await paperless.get_entity_name_map("/api/correspondents/")
    document_type_names = await paperless.get_entity_name_map("/api/document_types/")
    tag_names_by_id = await paperless.get_entity_name_map("/api/tags/")
    blocks: list[str] = []
    for d in docs:
        text = (d.get("content") or "").strip()
        if not text:
            continue
        ai_fields = {
            name_by_id[cf["field"]]: cf.get("value")
            for cf in d.get("custom_fields", [])
            if cf.get("field") in name_by_id
        }
        correspondent_name = correspondent_names.get(d.get("correspondent"))
        document_type_name = document_type_names.get(d.get("document_type"))
        if not (document_type_name or ai_fields.get("ai_document_type")):
            continue
        # Native suggested-tags = user-curated tag set minus the AI lifecycle tags.
        tag_names = [
            tag_names_by_id[tid]
            for tid in d.get("tags") or []
            if tid in tag_names_by_id and tag_names_by_id[tid] not in _LIFECYCLE_TAG_NAMES
        ]
        excerpt = text[:_FEW_SHOT_TEXT_LIMIT]
        if len(text) > _FEW_SHOT_TEXT_LIMIT:
            excerpt += "\n[...gekürzt]"
        rendered = _example_payload(
            ai_fields,
            correspondent_name=correspondent_name,
            document_type_name=document_type_name,
            created_date=d.get("created_date"),
            tag_names=tag_names,
        )
        blocks.append(f"Eingabe-Text:\n{excerpt}\n\nErwartete Ausgabe (JSON):\n{rendered}")
    if not blocks:
        return ""
    return (
        "Hier sind Beispiele aus geprüften, früheren Extraktionen — "
        "halte dich an Stil und Detailtiefe der Korrespondent- und Zusammenfassungsangaben:\n\n"
        + "\n\n---\n\n".join(blocks)
    )


_HISTORY_HEAD_CHARS = 1000
_HISTORY_DOMINANT_THRESHOLD = 0.7
_HISTORY_MIN_SAMPLES = 2


def _format_history_hint(
    history: dict[str, dict[str, int]], text: str
) -> str:
    """Return a German-language hint paragraph if the document text mentions a
    correspondent we have prior history on. Pure function — caller passes the
    already-fetched history map and the OCR text.

    The hint either:
      - names the dominant past document_type (>=70% of >=2 prior docs), or
      - lists the full distribution if no clear winner.

    Returns "" when no known correspondent is found in the document head.
    """
    if not history:
        return ""
    head = text[:_HISTORY_HEAD_CHARS]
    matches = sorted(
        (name for name in history if name in head),
        key=len,
        reverse=True,
    )
    if not matches:
        return ""
    name = matches[0]
    types = history[name]
    total = sum(types.values())
    if total == 0:
        return ""
    dominant = max(types, key=types.get)
    dom_share = types[dominant] / total
    if dom_share >= _HISTORY_DOMINANT_THRESHOLD and total >= _HISTORY_MIN_SAMPLES:
        return (
            f"Hinweis aus früheren Dokumenten: Dokumente von '{name}' wurden "
            f"in {types[dominant]} von {total} Fällen als '{dominant}' "
            f"klassifiziert. Berücksichtige dies, weiche aber ab, wenn der "
            f"Inhalt dieses Dokuments klar nicht passt."
        )
    dist = ", ".join(f"{k}: {v}" for k, v in sorted(types.items(), key=lambda kv: -kv[1]))
    return (
        f"Hinweis aus früheren Dokumenten von '{name}': bisherige "
        f"Klassifikationen: {dist}. Wähle den passendsten Typ."
    )


async def _build_history_hint(paperless: PaperlessClient, text: str) -> str:
    try:
        history = await paperless.get_correspondent_history()
    except Exception as exc:
        log.warning("history_fetch_failed", error=str(exc))
        return ""
    return _format_history_hint(history, text)


def _route_lifecycle_tags(extraction: DocumentExtraction, settings: Settings) -> list[str]:
    """Decide which lifecycle/auxiliary tags to apply based on confidence routing.

    Returns the tag names to add. When confidence ≥ AUTO_APPROVE_CONFIDENCE
    (any document type) the doc goes straight to `ai-approved` and we add
    the auxiliary marker `ai-auto-approved` so the UI can render an
    "auto-genehmigt" badge — the marker persists through propagation because
    the propagator only strips `ai-approved`. Otherwise the doc lands in
    `ai-pending`; if confidence is below LOW_CONFIDENCE_THRESHOLD we
    additionally tag `ai-low-confidence` so the user can prioritise it.
    """
    if extraction.confidence >= settings.auto_approve_confidence:
        return ["ai-approved", "ai-auto-approved"]
    tags = ["ai-pending"]
    if extraction.confidence < settings.low_confidence_threshold:
        tags.append("ai-low-confidence")
    return tags


async def _apply_tags(
    paperless: PaperlessClient, doc: dict, tag_names: list[str]
) -> None:
    """Add the named tags to a document in a single PATCH (preserves existing)."""
    target_ids = [await paperless.get_or_create_tag(name) for name in tag_names]
    new_set = set(doc.get("tags", [])) | set(target_ids)
    await paperless.patch_document_native_fields(doc["id"], tags=sorted(new_set))


async def process_document(
    doc: dict,
    paperless: PaperlessClient,
    backend: LLMBackend,
    settings: Settings,
) -> None:
    doc_id: int = doc["id"]
    title: str = doc.get("title", f"doc-{doc_id}")
    logger = log.bind(doc_id=doc_id, title=title)

    content = await paperless.get_document_content(doc_id)
    if not content.strip():
        logger.warning("document_has_no_ocr_content")
        await paperless.add_tag_to_document(doc_id, "ai-error")
        return

    text = _truncate_text(content, settings.max_tokens_input)
    system_prompt = SYSTEM_PROMPT
    # Per-correspondent history hint goes BEFORE the few-shot block so the
    # "this sender is usually X" signal is the most prominent thing the model
    # sees right after the base taxonomy.
    if settings.use_correspondent_history:
        hint = await _build_history_hint(paperless, content)
        if hint:
            system_prompt = system_prompt + "\n\n" + hint
            logger.info("history_hint_attached", chars=len(hint))
    if settings.few_shot_examples > 0:
        try:
            few_shot = await _build_few_shot_block(paperless, settings.few_shot_examples)
        except Exception as exc:
            # Few-shot is best-effort — never let it block extraction.
            logger.warning("few_shot_build_failed", error=str(exc))
            few_shot = ""
        if few_shot:
            system_prompt = system_prompt + "\n\n---\n\n" + few_shot
            logger.info("few_shot_attached", chars=len(few_shot))
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Dokumenttext:\n\n{text}"},
    ]

    try:
        extraction: DocumentExtraction = await backend.complete(messages, DocumentExtraction)
    except Exception as exc:
        # Per-document fault boundary: any LLM/transport/validation failure
        # tags the doc and continues the polling loop. Don't narrow this —
        # backends (Anthropic, Ollama, future) raise different exception types
        # we cannot enumerate from this layer.
        logger.exception("extraction_failed", error=str(exc))
        await paperless.set_error_message(
            doc_id, _format_error("LLM-Extraktion fehlgeschlagen", exc)
        )
        await paperless.add_tag_to_document(doc_id, "ai-error")
        return

    logger.info(
        "extraction_successful",
        document_type=extraction.document_type.value,
        confidence=extraction.confidence,
    )

    # ai_title fallback: small local LLMs (gemma4 8B) routinely drop optional
    # string fields. Synthesize a deterministic title from document_type +
    # correspondent + issue date so Paperless's `title` is always meaningful
    # after propagation. The LLM's value wins when present and non-empty.
    if not (extraction.ai_title or "").strip():
        synthesized = _synthesize_ai_title(extraction)
        extraction = extraction.model_copy(update={"ai_title": synthesized})
        logger.info("ai_title_synthesized", title=synthesized)

    try:
        await paperless.patch_document_ai_fields(doc_id, extraction, backend.name, backend.model)
        lifecycle_tags = _route_lifecycle_tags(extraction, settings)
        await _apply_tags(paperless, doc, lifecycle_tags)
        logger.info("routing_decision", tags=lifecycle_tags, confidence=extraction.confidence)
    except Exception as exc:
        # Without an ai-error tag here the doc has no lifecycle tag and would be
        # re-processed forever on every poll cycle.
        logger.exception("paperless_write_failed", error=str(exc))
        try:
            await paperless.set_error_message(
                doc_id, _format_error("Paperless-Schreibvorgang fehlgeschlagen", exc)
            )
            await paperless.add_tag_to_document(doc_id, "ai-error")
        except Exception as tag_exc:
            logger.error("paperless_tag_failed", error=str(tag_exc))
        return

    # Pass 2: type-specific extraction. Non-fatal — generic pass already
    # completed successfully and lifecycle tags are set.
    if extraction.document_type != DocumentType.Sonstiges:
        await _run_type_specific_pass(
            doc_id=doc_id,
            doc_type=extraction.document_type,
            text=text,
            backend=backend,
            settings=settings,
            logger=logger,
        )
    return


async def _run_type_specific_pass(
    *,
    doc_id: int,
    doc_type: DocumentType,
    text: str,
    backend: LLMBackend,
    settings: Settings,
    logger: Any,
) -> None:
    if doc_type not in TYPE_FIELD_SCHEMA or not TYPE_FIELD_SCHEMA[doc_type]:
        return
    try:
        fields = await extract_type_specific(doc_type, text, backend)
        if not fields:
            logger.info("type_specific_pass_empty", doc_type=doc_type.value)
            return
        url = f"{settings.aktenraum_api_url}/api/documents/{doc_id}/type-fields"
        headers = {}
        if settings.webhook_secret:
            headers["X-Aktenraum-Secret"] = settings.webhook_secret
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json={"fields": fields}, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status >= 400:
                    body = await resp.text()
                    logger.warning(
                        "type_specific_patch_rejected",
                        doc_id=doc_id,
                        status=resp.status,
                        body=body[:200],
                    )
                else:
                    logger.info(
                        "type_specific_pass_done",
                        doc_type=doc_type.value,
                        fields=list(fields.keys()),
                    )
    except Exception as exc:
        logger.warning("type_specific_pass_failed", doc_id=doc_id, error=str(exc))


