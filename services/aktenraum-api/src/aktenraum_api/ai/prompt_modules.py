"""Per-doc-type prompt modules consumed by the filter and answer prompts.

Each `DocTypeModule` carries the *intent-aware* additions a doc type
contributes when its type shows up in either the user's question (filter
side, via `intent.detect_intents`) or the retrieved candidates (answer
side, via `candidates[i]['document_type']`).

`field_labels_for(doc_type)` resolves field labels from
`aktenraum_core.models.TYPE_FIELD_SCHEMA` so this module never duplicates
the schema — adding a typespecific field in one place automatically
appears in the prompt on the next request.

Pure module: no I/O, no settings dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentType


@dataclass(frozen=True)
class DocTypeModule:
    """Per-DocumentType prompt contributions.

    All fields default to empty so an entry can opt out of any subset
    (e.g. `Sonstiges` has no useful fields to point at).
    """

    # Pairs appended to the filter-prompt few-shot block whenever an
    # intent that implies this type fires. Shape mirrors the existing
    # static `_FEW_SHOT_EXAMPLES` entries in `prompt.py`.
    filter_examples: tuple[tuple[str, dict], ...] = ()

    # One sentence describing where the canonical value for typical
    # questions on this type lives. Rendered into the dynamic
    # "Feld-Hinweise" block of the answer prompt.
    answer_hint: str = ""

    # One assembled "Frage / Felder / Antwort" example demonstrating
    # field use. Rendered into the dynamic examples block of the
    # answer prompt.
    answer_example: str = ""


# ---------- Module table ----------------------------------------------------
#
# Order is irrelevant at runtime — the assemblers iterate by the doc types
# present in the question / candidates — but we keep the table aligned to
# the `DocumentType` enum order for grep parity with TYPE_FIELD_SCHEMA.

MODULES: Final[dict[DocumentType, DocTypeModule]] = {
    DocumentType.Rechnung: DocTypeModule(
        filter_examples=(
            (
                "Was hat die Stromrechnung im Januar 2025 gekostet?",
                {
                    "document_type": "Rechnung",
                    "date_from": "2025-01-01",
                    "date_to": "2025-01-31",
                    "text": "Strom",
                },
            ),
        ),
        answer_hint=(
            "Bei Rechnungen liegt der zu nennende Betrag in 'Gesamtbetrag "
            "(brutto)', ggf. ergänzt um Nettobetrag oder MwSt-Betrag."
        ),
        answer_example=(
            "Frage: 'Was hat die Stromrechnung gekostet?'\n"
            "Typenspezifische Felder: Gesamtbetrag (brutto): EUR149.99\n"
            "→ 'Die Stromrechnung betrug 149,99 €. [Quelle: 23]'"
        ),
    ),
    DocumentType.Gehaltsabrechnung: DocTypeModule(
        filter_examples=(
            (
                "Wie viel habe ich im März 2025 verdient?",
                {
                    "document_type": "Gehaltsabrechnung",
                    "date_from": "2025-03-01",
                    "date_to": "2025-03-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Gehaltsabrechnungen liegen Brutto- und Nettogehalt in den "
            "typenspezifischen Feldern; ergänze ggf. Steuerklasse, "
            "Lohnsteuer oder Sozialversicherung."
        ),
        answer_example=(
            "Frage: 'Wie viel habe ich im August 2025 verdient?'\n"
            "Typenspezifische Felder: Bruttogehalt: EUR4820.00, "
            "Nettogehalt: EUR3144.16\n"
            "→ 'Im August 2025 hast du brutto 4.820,00 € und netto "
            "3.144,16 € verdient. [Quelle: 126]'"
        ),
    ),
    DocumentType.Kontoauszug: DocTypeModule(
        filter_examples=(
            (
                "Kontoauszug Februar 2025",
                {
                    "document_type": "Kontoauszug",
                    "date_from": "2025-02-01",
                    "date_to": "2025-02-28",
                },
            ),
        ),
        answer_hint=(
            "Bei Kontoauszügen sind Zeitraum (von/bis) und End-/Anfangssaldo "
            "die typischen Antwortgrößen."
        ),
        answer_example=(
            "Frage: 'Wie hoch war mein Endsaldo im Februar 2025?'\n"
            "Typenspezifische Felder: Endsaldo: EUR4231.10\n"
            "→ 'Dein Endsaldo im Februar 2025 betrug 4.231,10 €. [Quelle: 88]'"
        ),
    ),
    DocumentType.Nebenkostenabrechnung: DocTypeModule(
        filter_examples=(
            (
                "Nebenkostenabrechnung 2024",
                {
                    "document_type": "Nebenkostenabrechnung",
                    "date_from": "2024-01-01",
                    "date_to": "2024-12-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Nebenkostenabrechnungen sind Nachzahlung (oder Guthaben) "
            "und Neue Vorauszahlung die häufigsten Antwortgrößen."
        ),
        answer_example=(
            "Frage: 'Muss ich für 2024 Nebenkosten nachzahlen?'\n"
            "Typenspezifische Felder: Nachzahlung / Guthaben: EUR287.43\n"
            "→ 'Du musst für 2024 287,43 € Nebenkosten nachzahlen. [Quelle: 41]'"
        ),
    ),
    DocumentType.Hausgeldabrechnung: DocTypeModule(
        filter_examples=(
            (
                "Hausgeldabrechnung 2023",
                {
                    "document_type": "Hausgeldabrechnung",
                    "date_from": "2023-01-01",
                    "date_to": "2023-12-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Hausgeldabrechnungen ist 'Nachzahlung / Guthaben (Saldo)' "
            "die Endsumme; Hausgeldanteil und Instandhaltungsrücklage geben "
            "Detailwerte."
        ),
        answer_example=(
            "Frage: 'Wie hoch war mein Hausgeldsaldo 2023?'\n"
            "Typenspezifische Felder: Nachzahlung / Guthaben (Saldo): EUR-123.50\n"
            "→ 'Du hast 2023 einen Saldo von -123,50 € (Guthaben). [Quelle: 12]'"
        ),
    ),
    DocumentType.Mahnung: DocTypeModule(
        filter_examples=(
            (
                "Mahnungen aus 2025",
                {
                    "document_type": "Mahnung",
                    "date_from": "2025-01-01",
                    "date_to": "2025-12-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Mahnungen ist 'Gesamtforderung (inkl. Gebühren)' die "
            "fällige Summe; Zahlungsfrist nennt den Stichtag."
        ),
        answer_example=(
            "Frage: 'Wie hoch ist die offene Mahnforderung?'\n"
            "Typenspezifische Felder: Gesamtforderung (inkl. Gebühren): EUR89.50, "
            "Zahlungsfrist: 2025-04-15\n"
            "→ 'Die offene Mahnforderung beträgt 89,50 €, fällig zum 15.04.2025. [Quelle: 77]'"
        ),
    ),
    DocumentType.Vertrag: DocTypeModule(
        filter_examples=(
            (
                "Verträge im ersten Quartal 2024",
                {
                    "document_type": "Vertrag",
                    "date_from": "2024-01-01",
                    "date_to": "2024-03-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Verträgen sind Vertragsbeginn, Kündigungsfrist und "
            "Vertragsgegenstand die Schlüsselangaben."
        ),
        answer_example=(
            "Frage: 'Welche Kündigungsfrist hat mein Mietvertrag?'\n"
            "Typenspezifische Felder: Kündigungsfrist: 3 Monate zum Monatsende\n"
            "→ 'Dein Mietvertrag hat eine Kündigungsfrist von 3 Monaten zum "
            "Monatsende. [Quelle: 5]'"
        ),
    ),
    DocumentType.Kuendigung: DocTypeModule(
        answer_hint=(
            "Bei Kündigungen ist 'Wirksamkeit ab' das Schlüssel-Datum."
        ),
        answer_example=(
            "Frage: 'Ab wann wirkt meine Kündigung?'\n"
            "Typenspezifische Felder: Wirksamkeit ab: 2025-06-30\n"
            "→ 'Deine Kündigung wird zum 30.06.2025 wirksam. [Quelle: 31]'"
        ),
    ),
    DocumentType.Versicherung: DocTypeModule(
        filter_examples=(
            (
                "Meine Hausratversicherung",
                {
                    "document_type": "Versicherung",
                    "text": "Hausrat",
                },
            ),
        ),
        answer_hint=(
            "Bei Versicherungen ist 'Jahresprämie' der Beitrag; "
            "'Selbstbeteiligung' und 'Versicherungsart' sind häufige Zusatzfragen."
        ),
        answer_example=(
            "Frage: 'Wie viel kostet meine Hausratversicherung im Jahr?'\n"
            "Typenspezifische Felder: Jahresprämie: EUR184.20, "
            "Versicherungsart: Hausrat\n"
            "→ 'Deine Hausratversicherung kostet 184,20 € pro Jahr. [Quelle: 60]'"
        ),
    ),
    DocumentType.Steuer: DocTypeModule(
        filter_examples=(
            (
                "Steuerbescheid 2022",
                {
                    "document_type": "Steuer",
                    "date_from": "2022-01-01",
                    "date_to": "2022-12-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Steuerdokumenten nennt 'Erstattung / Nachzahlung' den "
            "Saldo; Steuerjahr und Steuerart sortieren die Filterantwort."
        ),
        answer_example=(
            "Frage: 'Wie hoch war meine Steuererstattung für 2022?'\n"
            "Typenspezifische Felder: Erstattung / Nachzahlung: EUR412.00, "
            "Steuerjahr: 2022\n"
            "→ 'Deine Steuererstattung für 2022 betrug 412,00 €. [Quelle: 99]'"
        ),
    ),
    DocumentType.Lohnsteuerbescheinigung: DocTypeModule(
        filter_examples=(
            (
                "Lohnsteuerbescheinigung 2024",
                {
                    "document_type": "Lohnsteuerbescheinigung",
                    "date_from": "2024-01-01",
                    "date_to": "2024-12-31",
                },
            ),
        ),
        answer_hint=(
            "Bei Lohnsteuerbescheinigungen sind 'Brutto-Arbeitslohn (Zeile 3)' "
            "und 'Einbehaltene Lohnsteuer (Zeile 4)' die Jahressummen."
        ),
        answer_example=(
            "Frage: 'Wie viel Lohnsteuer wurde 2024 einbehalten?'\n"
            "Typenspezifische Felder: Einbehaltene Lohnsteuer (Zeile 4): EUR8743.21, "
            "Brutto-Arbeitslohn (Zeile 3): EUR58420.00\n"
            "→ 'Für 2024 wurden 8.743,21 € Lohnsteuer einbehalten "
            "(Brutto-Arbeitslohn 58.420,00 €). [Quelle: 71]'"
        ),
    ),
    DocumentType.Spendenbescheinigung: DocTypeModule(
        answer_hint=(
            "Bei Spendenbescheinigungen sind 'Spendenbetrag', 'Spendenempfänger' "
            "und 'Datum der Zuwendung' die typischen Antwortgrößen."
        ),
        answer_example=(
            "Frage: 'Wie hoch war meine Spende an die Tafel 2024?'\n"
            "Typenspezifische Felder: Spendenbetrag: EUR120.00, "
            "Spendenempfänger (Organisation): Tafel Deutschland e.V., "
            "Datum der Zuwendung: 2024-11-12\n"
            "→ 'Du hast am 12.11.2024 120,00 € an die Tafel Deutschland e.V. "
            "gespendet. [Quelle: 152]'"
        ),
    ),
    DocumentType.Bescheid: DocTypeModule(
        answer_hint=(
            "Bei Bescheiden sind Aktenzeichen, Behörde und Widerspruchsfrist "
            "die Schlüsselangaben."
        ),
        answer_example=(
            "Frage: 'Bis wann kann ich gegen den Bescheid Widerspruch einlegen?'\n"
            "Typenspezifische Felder: Widerspruchsfrist: 2025-03-20\n"
            "→ 'Du kannst bis zum 20.03.2025 Widerspruch einlegen. [Quelle: 44]'"
        ),
    ),
    DocumentType.Behoerdenbrief: DocTypeModule(
        answer_hint=(
            "Bei Behördenbriefen sind Behörde und Aktenzeichen oft die "
            "einzigen strukturierten Angaben — Details stehen meist im Text."
        ),
        answer_example=(
            "Frage: 'Welche Behörde hat sich gemeldet?'\n"
            "Typenspezifische Felder: Behörde: Bürgeramt Mitte\n"
            "→ 'Die Anfrage kommt vom Bürgeramt Mitte. [Quelle: 19]'"
        ),
    ),
    DocumentType.Sozialversicherungsmeldung: DocTypeModule(
        answer_hint=(
            "Bei Sozialversicherungsmeldungen sind 'Brutto-Arbeitsentgelt', "
            "Beitragszeitraum und Sozialversicherungsnummer die zentralen "
            "Felder."
        ),
        answer_example=(
            "Frage: 'Wie hoch war mein SV-Brutto 2024?'\n"
            "Typenspezifische Felder: Brutto-Arbeitsentgelt: EUR58420.00, "
            "Beitragszeitraum von: 2024-01-01, Beitragszeitraum bis: 2024-12-31\n"
            "→ 'Dein SV-Brutto für 2024 betrug 58.420,00 €. [Quelle: 64]'"
        ),
    ),
    DocumentType.Kfz: DocTypeModule(
        filter_examples=(
            (
                "Wann ist die nächste TÜV?",
                {"document_type": "Kfz"},
            ),
        ),
        answer_hint=(
            "Bei Kfz-Dokumenten sind 'Nächste HU/TÜV', Kennzeichen und "
            "VIN die Standardangaben."
        ),
        answer_example=(
            "Frage: 'Wann ist die nächste HU?'\n"
            "Typenspezifische Felder: Nächste HU/TÜV: 2026-08-15, "
            "Kennzeichen: B-XY-1234\n"
            "→ 'Die nächste HU für B-XY-1234 ist am 15.08.2026 fällig. [Quelle: 7]'"
        ),
    ),
    DocumentType.Bussgeldbescheid: DocTypeModule(
        answer_hint=(
            "Bei Bußgeldbescheiden sind Bußgeld, Tatzeit, Tatbestand und "
            "Einspruchsfrist die zentralen Felder."
        ),
        answer_example=(
            "Frage: 'Wie hoch ist mein Bußgeld?'\n"
            "Typenspezifische Felder: Bußgeld / Verwarnungsgeld: EUR35.00, "
            "Tatbestand / Verstoß: 21 km/h zu schnell, "
            "Einspruchsfrist: 2025-02-28\n"
            "→ 'Dein Bußgeld beträgt 35,00 € (21 km/h zu schnell), "
            "Einspruch bis 28.02.2025 möglich. [Quelle: 28]'"
        ),
    ),
    DocumentType.Arztbrief: DocTypeModule(
        answer_hint=(
            "Bei Arztbriefen sind Behandlungsdatum, Diagnose und Facharzt "
            "die Standardangaben."
        ),
        answer_example=(
            "Frage: 'Welche Diagnose stellte Dr. Meier?'\n"
            "Typenspezifische Felder: Diagnose: Lumbago, Facharzt / Arzt: "
            "Dr. Meier, Behandlungsdatum: 2025-01-08\n"
            "→ 'Dr. Meier diagnostizierte am 08.01.2025 Lumbago. [Quelle: 53]'"
        ),
    ),
    DocumentType.Krankschreibung: DocTypeModule(
        answer_hint=(
            "Bei Krankschreibungen sind 'Arbeitsunfähig von/bis' und "
            "Erst-/Folgebescheinigung die Schlüsselangaben."
        ),
        answer_example=(
            "Frage: 'Bis wann bin ich krankgeschrieben?'\n"
            "Typenspezifische Felder: Arbeitsunfähig von: 2025-02-10, "
            "Arbeitsunfähig bis (voraussichtlich): 2025-02-14\n"
            "→ 'Du bist bis voraussichtlich 14.02.2025 krankgeschrieben. [Quelle: 90]'"
        ),
    ),
    DocumentType.Garantie: DocTypeModule(
        answer_hint=(
            "Bei Garantien sind Produktname, Kaufdatum und Seriennummer "
            "die zentralen Felder."
        ),
        answer_example=(
            "Frage: 'Wann habe ich den Geschirrspüler gekauft?'\n"
            "Typenspezifische Felder: Produktname: Bosch SMV4HVX33E, "
            "Kaufdatum: 2024-04-22, Kaufpreis: EUR589.00\n"
            "→ 'Du hast den Bosch SMV4HVX33E am 22.04.2024 für 589,00 € "
            "gekauft. [Quelle: 38]'"
        ),
    ),
    DocumentType.Urkunde: DocTypeModule(
        answer_hint=(
            "Bei Urkunden ist die Urkundenart die einzige strukturierte "
            "Angabe — Details (Namen, Daten) stehen im Text."
        ),
        answer_example=(
            "Frage: 'Was für eine Urkunde ist das?'\n"
            "Typenspezifische Felder: Urkundenart: Geburtsurkunde\n"
            "→ 'Das ist eine Geburtsurkunde. [Quelle: 6]'"
        ),
    ),
    DocumentType.Ausweis: DocTypeModule(
        filter_examples=(
            (
                "Wann läuft mein Personalausweis ab?",
                {"document_type": "Ausweis"},
            ),
        ),
        answer_hint=(
            "Bei Ausweisen ist 'Ausstellung' das Ausstellungsdatum (aus den "
            "AI-Metadatenfeldern) und 'Ausweisnummer' die Identifikation."
        ),
        answer_example=(
            "Frage: 'Wann wurde mein Pass ausgestellt?'\n"
            "Dokument hat Ausstellung: 2024-05-12\n"
            "→ 'Dein Pass wurde am 12.05.2024 ausgestellt. [Quelle: 17]'"
        ),
    ),
    DocumentType.Zeugnis: DocTypeModule(
        answer_hint=(
            "Bei Zeugnissen sind Gesamtnote und Aussteller die "
            "üblichen Antwortgrößen."
        ),
        answer_example=(
            "Frage: 'Welche Gesamtnote hatte ich im Abitur?'\n"
            "Typenspezifische Felder: Gesamtnote: 1,8, Aussteller: "
            "Gymnasium Beispielstadt\n"
            "→ 'Deine Abiturnote war 1,8 (Gymnasium Beispielstadt). [Quelle: 22]'"
        ),
    ),
    DocumentType.Arbeitszeugnis: DocTypeModule(
        filter_examples=(
            (
                "Mein letztes Arbeitszeugnis",
                {"document_type": "Arbeitszeugnis"},
            ),
        ),
        answer_hint=(
            "Bei Arbeitszeugnissen sind 'Beschäftigung von/bis', Arbeitgeber "
            "und Gesamtbeurteilung die Schlüsselangaben."
        ),
        answer_example=(
            "Frage: 'Wie lange habe ich bei Kopfstand gearbeitet?'\n"
            "Typenspezifische Felder: Arbeitgeber: Kopfstand GmbH, "
            "Beschäftigung von: 2022-03-01, Beschäftigung bis: 2024-12-31\n"
            "→ 'Du warst von März 2022 bis Dezember 2024 bei Kopfstand "
            "GmbH beschäftigt. [Quelle: 16]'"
        ),
    ),
    DocumentType.Mitgliedschaft: DocTypeModule(
        answer_hint=(
            "Bei Mitgliedschaften sind Mitgliedsnummer und Jahresbeitrag "
            "die zentralen Felder."
        ),
        answer_example=(
            "Frage: 'Wie hoch ist mein Vereinsbeitrag?'\n"
            "Typenspezifische Felder: Jahresbeitrag: EUR60.00, "
            "Mitgliedsnummer: A-12345\n"
            "→ 'Dein Vereinsbeitrag beträgt 60,00 € pro Jahr (Mitgliedsnr. "
            "A-12345). [Quelle: 49]'"
        ),
    ),
    DocumentType.Sonstiges: DocTypeModule(),
}


# Integrity guard: every DocumentType must have a module so the
# `_assert_all_doc_types_covered` test fails loudly when a new type is
# added without a corresponding entry. Build-time check; not runtime.
def _assert_all_doc_types_covered() -> None:
    missing = [dt for dt in DocumentType if dt not in MODULES]
    if missing:  # pragma: no cover - covered by the importing test
        raise AssertionError(
            f"prompt_modules.MODULES missing entries for: {missing}"
        )


_assert_all_doc_types_covered()


# ---------- Lookup helpers --------------------------------------------------


def field_labels_for(doc_type: DocumentType) -> list[str]:
    """German labels of every typespecific field for `doc_type`.

    Resolved from `TYPE_FIELD_SCHEMA` so adding a new field to the schema
    automatically widens what the answer prompt instructs the model to use.
    Returns an empty list for `Sonstiges` and any future type added with
    no fields.
    """
    return [f.label_de for f in TYPE_FIELD_SCHEMA.get(doc_type) or []]


def module_for(doc_type: DocumentType) -> DocTypeModule:
    """Module for `doc_type`. Always non-None because the integrity guard
    asserts coverage at import time."""
    return MODULES[doc_type]


def parse_document_type(value: str | None) -> DocumentType | None:
    """Lenient `DocumentType` lookup that swallows unknown values.

    Candidates carry the doc-type as a string (the projection in
    `_doc_to_summary` / `_enrich_with_ai_fields` does not preserve the
    enum), so the assemblers need a defensive parser.
    """
    if not value:
        return None
    try:
        return DocumentType(value)
    except ValueError:
        return None
