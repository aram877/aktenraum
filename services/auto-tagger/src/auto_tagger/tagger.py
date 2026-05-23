import json
from datetime import date
from typing import Any

import aiohttp
import structlog
from aktenraum_core.llm import LLMBackend, extract_type_specific
from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentExtraction, DocumentType
from aktenraum_core.paperless import PaperlessClient

from .auto_approve_config import RuleSet, get_rules
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


def _synthesize_summary_de(extraction: DocumentExtraction) -> str:
    """Build a deterministic German summary when the LLM dropped `summary_de`.

    Small local models (≤8B) routinely emit `""` for summary_de despite the
    "exactly 3 sentences" prompt rule. Pydantic accepts the empty string
    because `summary_de` has `default=""`, so without a fallback the field
    lands blank in Paperless. Mirrors the existing `_synthesize_ai_title` /
    `_fallback_confidence_reason` pattern.

    Strategy: build short, factual German sentences out of the fields we
    know are present. Result is never empty (document_type is required on
    DocumentExtraction). Quality is modest by design — the goal is "non-
    empty, not wrong" so the SPA always has something to show. A larger
    model's natural-language summary wins whenever the LLM emits one.
    """
    doc_type = extraction.document_type.value
    correspondent = (extraction.correspondent or "").strip()
    title = (extraction.ai_title or "").strip()
    date_de = _format_issue_date_de(extraction.key_dates.issue)

    sentences: list[str] = []

    # Sentence 1: type + sender + date — the core identification line.
    if correspondent and date_de:
        sentences.append(f"{doc_type} von {correspondent} vom {date_de}.")
    elif correspondent:
        sentences.append(f"{doc_type} von {correspondent}.")
    elif date_de:
        sentences.append(f"{doc_type} vom {date_de}.")
    else:
        sentences.append(f"{doc_type}.")

    # Sentence 2: surface the AI title when it carries info beyond sentence 1.
    if title and title.lower() not in sentences[0].lower():
        sentences.append(f"Betreff: {title}.")

    # Sentence 3: prefer reference numbers (concrete, actionable) over tags.
    refs = [r for r in extraction.reference_numbers if r and r.strip()][:3]
    if refs:
        sentences.append(f"Aktenzeichen: {', '.join(refs)}.")
    else:
        tags = [t for t in extraction.suggested_tags if t and t.strip()][:3]
        if tags:
            sentences.append(f"Themen: {', '.join(tags)}.")

    return " ".join(sentences)


def _synthesize_suggested_tags(extraction: DocumentExtraction) -> list[str]:
    """Derive minimal fallback tags when the LLM returns [].

    Medium and smaller models return [] for suggested_tags despite the "2–5
    tags" instruction. Rich topic keywords require the document content, which
    we no longer have at fallback time, so we produce structural tags instead
    (document type + issue year). These are still useful search anchors —
    always better than blank.
    """
    tags: list[str] = [extraction.document_type.value]
    issue = (extraction.key_dates.issue or "").strip()
    if len(issue) >= 4 and issue[:4].isdigit():
        tags.append(issue[:4])
    return tags


# German reference-number patterns the heuristic extractor looks for in OCR
# text. Each entry: label (just for logging), and a regex that captures the
# value to the right of the label. The value pattern is intentionally
# narrow — only alphanumeric runs with /, -, ., _ separators — so OCR noise
# ("Adresse: …") doesn't get harvested. Bounded to 32 chars to defeat
# pathological lines.
_REFERENCE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("aktenzeichen", r"Aktenzeichen[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("az", r"\bAz\.?[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("rechnungsnr", r"Rechnungs(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("vertragsnr", r"Vertrags(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("kundennr", r"Kunden(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("vorgangsnr", r"Vorgangs?(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("bestellnr", r"Bestell(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("auftragsnr", r"Auftrags(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("policennr", r"Policen(?:-?Nr\.?|nummer)[:\s]+([A-Z0-9][A-Z0-9\-./_]{2,31})"),
    ("steuernr", r"Steuer(?:-?Nr\.?|nummer)[:\s]+([0-9][0-9\-./_]{2,31})"),
)


def _extract_reference_numbers_from_text(text: str, *, limit: int = 5) -> list[str]:
    """Fallback heuristic: pull common German reference numbers out of OCR text.

    Triggered only when the LLM emits an empty `reference_numbers` list AND
    the OCR contains one of `_REFERENCE_PATTERNS`. Returns the first `limit`
    distinct matches in label-priority order (Aktenzeichen > Az. > Rechnungsnr.
    > …). Case-insensitive on the label; case-preserving on the captured value.

    Conservative on purpose: a too-greedy regex would harvest dates, phone
    numbers, IBANs etc., creating noisy "Aktenzeichen" entries the user has
    to clean up. Limit-32-char numeric/alpha runs after one of the explicit
    German labels rules out almost all false positives.
    """
    if not text:
        return []
    import re

    out: list[str] = []
    seen_lc: set[str] = set()
    for _label, pattern in _REFERENCE_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            value = match.group(1).strip(".,;:- ")
            if not value:
                continue
            lc = value.lower()
            if lc in seen_lc:
                continue
            seen_lc.add(lc)
            out.append(value)
            if len(out) >= limit:
                return out
    return out

log = structlog.get_logger()

SYSTEM_PROMPT = """\
Du bist ein Assistent zur automatischen Klassifikation und Extraktion von deutschen Dokumenten.

Du erhältst den OCR-Text eines gescannten Dokuments und extrahierst daraus strukturierte Metadaten.

Wähle den document_type anhand dieser Definitionen — nimm immer den spezifischsten passenden Typ:

- Rechnung: Forderung zur Zahlung — eine Rechnung verlangt einen Betrag, ist meist noch nicht bezahlt. Typische Merkmale: "Rechnung Nr.", Fälligkeitsdatum / Zahlungsziel, IBAN/Bankverbindung zur Überweisung, "bitte überweisen Sie bis ...". NICHT verwechseln mit: Beleg/Quittung (das ist die Zahlungs-BESTÄTIGUNG nach Begleichung; siehe unten). Wenn Rechnung UND Bezahlt-Bestätigung im selben Dokument stehen (z.B. Kassenbon-Rechnung), bleibt es Rechnung.
- Beleg: Zahlungs-Bestätigung / Quittung / Kassenbon / Receipt — beweist, dass eine Zahlung erfolgt IST. Typische Merkmale: "Receipt", "Zahlungsbestätigung", "Quittung", "Vielen Dank für Ihre Zahlung", "Paid"; nennt oft die Zahlungsart (Kreditkarte X****1234, PayPal, Lastschrift); referenziert manchmal eine zugehörige Rechnungsnummer; kein Fälligkeitsdatum mehr. NICHT verwechseln mit: Rechnung (siehe oben — die fordert noch Geld), Kontoauszug (listet viele Transaktionen einer Bank-/Kreditkartenperiode, nicht eine einzelne).
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
- Bußgeldbescheid: Bußgeld- oder Verwarngeldbescheid (auch Anhörungsbogen) wegen Verkehrsverstoß. Typische Inhalte: Tatzeit/Tatort, Kennzeichen, Tatbestand, Bußgeld/Verwarngeld, Punkte in Flensburg, Einspruchsfrist. Aliasnamen: Verwarnung, Verkehrsbescheid. NICHT verwechseln mit: Kfz-Dokumenten (Zulassung, TÜV), Steuerbescheid → Bescheid.
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
  • Bußgeldbescheid: "Bußgeldbescheid {Kennzeichen oder Behörde} {Datum}" — z.B. "Bußgeldbescheid K-AB-123 März 2024"
  • Arztbrief: "Arztbrief {Facharzt/Praxis} {Datum}" — z.B. "Arztbrief Dr. Müller März 2024"
  • Krankschreibung: "Krankschreibung {Arzt} {Zeitraum}" — z.B. "Krankschreibung Dr. Müller 12.–19.03.2024"
  • Garantie: "Garantie {Produkt} {Marke}" — z.B. "Garantie Waschmaschine Bosch"
  • Urkunde: "{Urkundenart} {Name oder Datum}" — z.B. "Geburtsurkunde Max Mustermann"
  • Ausweis: "{Ausweisart} {Inhabername}" — z.B. "Personalausweis Max Mustermann"
  • Zeugnis: "{Zeugnisart} {Institution} {Jahr}" — z.B. "Abiturzeugnis Goethe-Gymnasium 2020"
  • Arbeitszeugnis: "Arbeitszeugnis {Arbeitgeber} {Zeitraum}" — z.B. "Arbeitszeugnis Acme GmbH 2020–2024"
  • Mitgliedschaft: "{Organisation} Mitgliedschaft {Jahr}" — z.B. "ADAC Mitgliedschaft 2024"
  • Beleg: "Beleg {Firma} {Monat Jahr}" — z.B. "Beleg Anthropic März 2024" oder "Beleg Apple Store November 2024"
  • Sonstiges: kurze inhaltliche Beschreibung — z.B. "Lebenslauf Max Mustermann" oder "Foto Reisepass"
- Geldbeträge gehören NICHT in das generische Schema. Werte zu Beträgen, Gebühren, Bruttosummen, Nettosummen, Rückerstattungen, Forderungen, Prämien, Beiträgen etc. werden im typspezifischen Schritt (Pass 2) erfasst, falls der Dokumenttyp passende Felder vorsieht (z.B. Rechnung → gesamtbetrag, Mahnung → forderungsbetrag, Steuer → erstattung). Im hier vorliegenden Schritt KEINEN Geldbetrag ausgeben.
- summary_de: PFLICHTFELD, NIE leer. Genau 3 Sätze auf Deutsch:
  • Satz 1 — was es ist und von wem (z.B. "Rechnung der Stadtwerke München vom März 2024.").
  • Satz 2 — worum es konkret geht (Betrag, Vertragsdetails, Ergebnis des Bescheids, Inhalt des Schreibens).
  • Satz 3 — relevante Fristen, Aktenzeichen, Zusatzinformationen oder eine kurze inhaltliche Einordnung.
  Auch bei kurzen oder fragmentierten Dokumenten NIE leer lassen. Wenn Details fehlen, fasse zusammen was lesbar war, statt ein leeres Feld zurückzugeben.
- reference_numbers: Liste der im Dokument vorkommenden Geschäftsnummern (Aktenzeichen, Rechnungsnr., Vertragsnr., Kundennr., Vorgangsnr., Bestellnr., Auftragsnr., Policennr., Steuernr.). Suche aktiv im OCR-Text nach Labels wie "Az.:", "Aktenzeichen:", "Rechnungs-Nr.:" und nimm den dahinter stehenden Wert auf (z.B. "K-2024/00123"). Leere Liste NUR wenn das Dokument nachweislich keine solche Nummer enthält.
- suggested_tags: 2–5 deutsche Schlagwörter, die das Dokument für die spätere Suche brauchbar machen. Nimm konkrete inhaltliche Begriffe (Produkt, Vorgangsart, Themengebiet, Marke) — KEINE Wiederholung von document_type oder correspondent. Beispiele: Für eine KFZ-Rechnung über eine Reifenwechsel-Werkstatt → ["Reifen", "Werkstatt", "Saisonservice"]. Für einen Mietvertrag über eine WG-Wohnung → ["Miete", "WG", "Wohnung"]. Leere Liste nur wenn wirklich kein verwertbares Schlagwort ableitbar ist.
- confidence gibt an, wie sicher du dir bei der Extraktion bist (0.0 = unsicher, 1.0 = sehr sicher)
- confidence_reason: PFLICHTFELD wenn confidence gesetzt ist. Gib einen kurzen deutschen Satz (max. ~20 Wörter) zurück, der ehrlich begründet, was diesen konkreten Konfidenzwert getrieben hat. Nenne den Hauptgrund — was war eindeutig, was war zweifelhaft? Beispiele:
  • hoch (0.9+): "Klarer Briefkopf, Rechnungsnummer und Betrag sauber lesbar."
  • mittel (0.4–0.7): "Dokumenttyp eindeutig, aber Korrespondent nur aus dem Briefkopf erschlossen — IBAN fehlt."
  • niedrig (<0.4): "OCR fragmentiert mehrere Datumsfelder; kein klarer Briefkopf vorhanden."
  Verbiete generische Floskeln ("hohe Sicherheit", "passt schon"). Wenn alles eindeutig ist, sage WAS eindeutig war.
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


def _fallback_confidence_reason(confidence: float) -> str:
    """Tier-based default reason for few-shot examples whose source docs
    pre-date the ai_confidence_reason field.

    Few-shot examples drive small-model output shape much more strongly
    than explicit "PFLICHTFELD" instructions. If an example omits the
    field the model will too. Concrete tier-appropriate sentences are
    better here than `null`, which the model would happily echo back.
    """
    if confidence >= 0.85:
        return (
            "Klarer Briefkopf, Dokumenttyp und Pflichtfelder eindeutig "
            "lesbar."
        )
    if confidence >= 0.6:
        return (
            "Dokumenttyp eindeutig, Korrespondent aus Briefkopf erschlossen; "
            "einzelne Felder leicht unscharf."
        )
    return (
        "OCR-Text in Teilen fragmentiert; Klassifikation auf Schlüsselwörter "
        "gestützt."
    )


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
    confidence = ai_fields.get("ai_confidence", 1.0)
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
        "confidence": confidence,
        # Few-shot examples MUST carry confidence_reason or small models
        # imitate the shape and drop it from their own output. Prefer the
        # doc's stored reason; fall back to a tier-appropriate sentence for
        # docs that pre-date the field.
        "confidence_reason": (
            ai_fields.get("ai_confidence_reason")
            or _fallback_confidence_reason(float(confidence))
        ),
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


def _route_lifecycle_tags(
    extraction: DocumentExtraction,
    settings: Settings,
    rules: RuleSet,
) -> tuple[list[str], str]:
    """Decide which lifecycle/auxiliary tags to apply based on confidence routing.

    Returns (tags, reason). `reason` is a closed-enum string explaining why
    the auto-approve gate did or didn't fire — purely for observability,
    surfaced via the `routing_decision` log line so an operator can grep
    `docker compose logs auto-tagger | grep routing_decision` and instantly
    see why a doc didn't auto-approve.

    Rules are sourced from the aktenraum-api `auto_approve_rules` table
    (edited in the SPA's Settings page, fetched here with a 60s TTL cache —
    see `auto_approve_config.get_rules`). Each `DocumentType` carries an
    `enabled` flag and a `min_confidence` threshold; auto-approve requires
    BOTH `enabled=true` AND `confidence ≥ min_confidence`.

    The fail-closed branch fires when the rule store was unreachable at
    cold start (the auto-tagger booted before aktenraum-api). Logged
    distinctly from `type_disabled` so operators can tell "rules say no"
    from "rules unreachable" without diff-reading the rule store.

    Reason values (closed enum, do not break compatibility with grep
    queries in runbooks):
      * "auto_approved"                    — type enabled and confidence high
      * "type_disabled"                    — type's rule.enabled is false
      * "confidence_below_min"              — type enabled, confidence too low
      * "rules_unreachable_fail_closed"    — rule store down at cold start
    """
    if rules.fail_closed:
        return _pending(extraction, settings), "rules_unreachable_fail_closed"
    rule = rules.get(extraction.document_type)
    if rule is None or not rule.enabled:
        return _pending(extraction, settings), "type_disabled"
    if extraction.confidence < rule.min_confidence:
        return _pending(extraction, settings), "confidence_below_min"
    return ["ai-approved", "ai-auto-approved"], "auto_approved"


def _pending(
    extraction: DocumentExtraction, settings: Settings
) -> list[str]:
    """Tag set when auto-approve didn't fire. Adds ai-low-confidence
    whenever the extraction's confidence is below LOW_CONFIDENCE_THRESHOLD,
    independent of which gate blocked the auto-approve path."""
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

    # confidence_reason fallback: same problem — local models drop the
    # field even though the prompt + few-shot exemplars include it. Falling
    # back to a tier-appropriate sentence is better than null because the
    # user gets *some* context for the score (the SPA shows the sentence
    # under the percentage). The LLM's value wins when present.
    if not (extraction.confidence_reason or "").strip():
        synthesized_reason = _fallback_confidence_reason(extraction.confidence)
        extraction = extraction.model_copy(
            update={"confidence_reason": synthesized_reason}
        )
        logger.info(
            "confidence_reason_synthesized",
            reason=synthesized_reason,
            confidence=extraction.confidence,
        )

    # reference_numbers heuristic: when the LLM drops the field but the OCR
    # text obviously contains one of the labelled German patterns
    # ("Aktenzeichen: …", "Rechnungsnr. …", …), harvest the most prominent
    # value. Triggered ONLY on empty list — the LLM's choices win whenever
    # it bothered to emit any. Operates on full `content` (not the truncated
    # `text` fed to the LLM) so a reference number on the last page of a
    # long doc still surfaces.
    if not extraction.reference_numbers:
        harvested_refs = _extract_reference_numbers_from_text(content)
        if harvested_refs:
            extraction = extraction.model_copy(
                update={"reference_numbers": harvested_refs}
            )
            logger.info(
                "reference_numbers_harvested",
                count=len(harvested_refs),
                values=harvested_refs,
            )

    # suggested_tags fallback: medium/small models return [] despite the
    # "2–5 tags" instruction. No content-based heuristic can recover rich
    # topic keywords without the OCR text, so we synthesize structural tags
    # (document type + year) as a minimal but always-non-empty search anchor.
    # The LLM's value always wins when non-empty.
    if not extraction.suggested_tags:
        synthesized_tags = _synthesize_suggested_tags(extraction)
        extraction = extraction.model_copy(update={"suggested_tags": synthesized_tags})
        logger.info("suggested_tags_synthesized", tags=synthesized_tags)

    # summary_de fallback: same drop-the-schema-field problem as ai_title
    # and confidence_reason. Pydantic accepts default="" silently, so empty
    # summaries flow straight to Paperless. Synthesize a short, factual
    # German line from the structured fields — never natural-language-good
    # but never empty either. The LLM's value wins when non-empty.
    if not (extraction.summary_de or "").strip():
        synthesized_summary = _synthesize_summary_de(extraction)
        extraction = extraction.model_copy(update={"summary_de": synthesized_summary})
        logger.info("summary_de_synthesized", chars=len(synthesized_summary))

    try:
        await paperless.patch_document_ai_fields(doc_id, extraction, backend.name, backend.model)
        rules = await get_rules(settings)
        lifecycle_tags, routing_reason = _route_lifecycle_tags(
            extraction, settings, rules
        )
        await _apply_tags(paperless, doc, lifecycle_tags)
        logger.info(
            "routing_decision",
            tags=lifecycle_tags,
            confidence=extraction.confidence,
            document_type=extraction.document_type.value,
            reason=routing_reason,
        )
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


