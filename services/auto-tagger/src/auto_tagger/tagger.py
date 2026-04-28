import structlog
from pydantic import ValidationError

from .llm.base import LLMBackend
from .models import DocumentExtraction
from .paperless import PaperlessClient

log = structlog.get_logger()

SYSTEM_PROMPT = """\
Du bist ein Assistent zur automatischen Klassifikation und Extraktion von deutschen Dokumenten.

Du erhältst den OCR-Text eines gescannten Dokuments und extrahierst daraus strukturierte Metadaten.

Wähle den document_type anhand dieser Definitionen — nimm immer den spezifischsten passenden Typ:

- Rechnung: Rechnungen, Quittungen, Kaufbelege für Waren oder Dienstleistungen (nicht von Versicherungen oder Behörden)
- Gehaltsabrechnung: Lohnabrechnung, Gehaltszettel, Brutto-Netto-Abrechnung, Bezügemitteilung, Rentenabrechnung
- Kontoauszug: Bank-, Kreditkarten-, Depot- und Sparkontoauszüge
- Nebenkostenabrechnung: Betriebskostenabrechnung, Jahresabrechnung für Strom, Gas, Wasser, Heizung, Hausgeld
- Mahnung: Zahlungserinnerungen, Mahnbescheide, Inkassoschreiben, Vollstreckungsbescheide
- Vertrag: Arbeitsvertrag, Mietvertrag, Kaufvertrag, Dienstleistungsvertrag, Darlehensvertrag, Vereinbarungen
- Kündigung: Kündigungsschreiben und Widerruf von Verträgen, Abonnements oder Mitgliedschaften
- Versicherung: Versicherungspolicen, Versicherungsnachweise, Deckungsbestätigungen, Schadensregulierung
- Steuer: Steuererklärungen, Steuerformulare (Anlage N, V, KAP etc.), Steuer-Bescheinigungen, Lohnsteuerbescheinigung
- Bescheid: Amtliche Bescheide mit Rechtswirkung — Steuerbescheid, Rentenbescheid, BAföG-Bescheid, Bewilligungs- oder Ablehnungsbescheid
- Behördenbrief: Amtliche Schreiben ohne Bescheidcharakter — Informationsschreiben, Antragsbestätigungen, Meldebescheinigung
- Kfz: Fahrzeugschein, Fahrzeugbrief, Zulassungsbescheinigung, TÜV-/HU-Bericht, Kfz-Steuer
- Arztbrief: Arztberichte, Befundbriefe, Laborbefunde, Überweisungen, Rezepte, Krankenhausentlassungsberichte, Impfnachweise
- Garantie: Garantieurkunden, Gewährleistungsnachweise, Garantiezertifikate für Geräte oder Produkte
- Urkunde: Geburtsurkunde, Heiratsurkunde, Sterbeurkunde, Apostille, notarielle Urkunden
- Ausweis: Scans von Personalausweis, Reisepass, Führerschein, Krankenversicherungskarte, Schwerbehindertenausweis
- Zeugnis: Schulzeugnisse, Hochschulabschlüsse, Ausbildungszeugnisse, Sprachzertifikate (z.B. TELC, Goethe)
- Arbeitszeugnis: Arbeitszeugnisse, Zwischenzeugnisse, Referenzschreiben von Arbeitgebern
- Mitgliedschaft: GEZ/ARD-ZDF-Beitrag, Vereinsbeitrag, Gewerkschaft, ADAC, Fitnessstudio, Streaming-Abonnements
- Sonstiges: Nur wenn kein anderer Typ passt (z.B. Lebenslauf, interne Notizen, Fotos)

Weitere Regeln:
- Datumsangaben immer im Format YYYY-MM-DD
- Geldbeträge immer mit Währung, z.B. "149,99 EUR"
- summary_de muss genau 3 Sätze auf Deutsch enthalten
- confidence gibt an, wie sicher du dir bei der Extraktion bist (0.0 = unsicher, 1.0 = sehr sicher)
- Wenn ein Feld nicht ermittelbar ist, setze es auf null
"""

_MAX_CHARS_PER_TOKEN = 4
_TRUNCATION_NOTICE = "\n\n[Dokument wurde aufgrund der Länge gekürzt.]"


def _truncate_text(text: str, max_tokens: int) -> str:
    max_chars = max_tokens * _MAX_CHARS_PER_TOKEN
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + _TRUNCATION_NOTICE


async def process_document(
    doc: dict,
    paperless: PaperlessClient,
    backend: LLMBackend,
    max_tokens_input: int,
) -> None:
    doc_id: int = doc["id"]
    title: str = doc.get("title", f"doc-{doc_id}")
    logger = log.bind(doc_id=doc_id, title=title)

    content = await paperless.get_document_content(doc_id)
    if not content.strip():
        logger.warning("document_has_no_ocr_content")
        await paperless.add_tag_to_document(doc_id, "ai-error")
        return

    text = _truncate_text(content, max_tokens_input)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Dokumenttext:\n\n{text}"},
    ]

    try:
        extraction: DocumentExtraction = await backend.complete(messages, DocumentExtraction)
    except (ValidationError, ValueError, Exception) as exc:
        logger.error("extraction_failed", error=str(exc))
        await paperless.add_tag_to_document(doc_id, "ai-error")
        return

    logger.info(
        "extraction_successful",
        document_type=extraction.document_type.value,
        confidence=extraction.confidence,
    )

    try:
        await paperless.patch_document_ai_fields(doc_id, extraction, backend.name, backend.model)
        await paperless.add_tag_to_document(doc_id, "ai-suggested")
    except Exception as exc:
        logger.error("paperless_write_failed", error=str(exc))
