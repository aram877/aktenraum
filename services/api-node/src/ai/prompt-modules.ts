import {
  DOCUMENT_TYPES,
  TYPE_FIELD_SCHEMA,
  type DocumentType,
} from "@aktenraum/core-ts";

export interface DocTypeModule {
  readonly filterExamples: readonly (readonly [string, Record<string, unknown>])[];
  readonly answerHint: string;
  readonly answerExample: string;
}

export const MODULES: Readonly<Record<DocumentType, DocTypeModule>> = {
  Rechnung: {
    filterExamples: [
      [
        "Was hat die Stromrechnung im Januar 2025 gekostet?",
        {
          document_type: "Rechnung",
          date_from: "2025-01-01",
          date_to: "2025-01-31",
          text: "Strom",
        },
      ],
    ],
    answerHint:
      "Bei Rechnungen liegt der zu nennende Betrag in 'Gesamtbetrag (brutto)', ggf. ergänzt um Nettobetrag oder MwSt-Betrag.",
    answerExample:
      "Frage: 'Was hat die Stromrechnung gekostet?'\nTypenspezifische Felder: Gesamtbetrag (brutto): EUR149.99\n→ 'Die Stromrechnung betrug 149,99 €. [Quelle: 23]'",
  },
  Gehaltsabrechnung: {
    filterExamples: [
      [
        "Wie viel habe ich im März 2025 verdient?",
        {
          document_type: "Gehaltsabrechnung",
          date_from: "2025-03-01",
          date_to: "2025-03-31",
        },
      ],
    ],
    answerHint:
      "Bei Gehaltsabrechnungen liegen Brutto- und Nettogehalt in den typenspezifischen Feldern; ergänze ggf. Steuerklasse, Lohnsteuer oder Sozialversicherung.",
    answerExample:
      "Frage: 'Wie viel habe ich im August 2025 verdient?'\nTypenspezifische Felder: Bruttogehalt: EUR4820.00, Nettogehalt: EUR3144.16\n→ 'Im August 2025 hast du brutto 4.820,00 € und netto 3.144,16 € verdient. [Quelle: 126]'",
  },
  Kontoauszug: {
    filterExamples: [
      [
        "Kontoauszug Februar 2025",
        {
          document_type: "Kontoauszug",
          date_from: "2025-02-01",
          date_to: "2025-02-28",
        },
      ],
    ],
    answerHint:
      "Bei Kontoauszügen sind Zeitraum (von/bis) und End-/Anfangssaldo die typischen Antwortgrößen.",
    answerExample:
      "Frage: 'Wie hoch war mein Endsaldo im Februar 2025?'\nTypenspezifische Felder: Endsaldo: EUR4231.10\n→ 'Dein Endsaldo im Februar 2025 betrug 4.231,10 €. [Quelle: 88]'",
  },
  Nebenkostenabrechnung: {
    filterExamples: [
      [
        "Nebenkostenabrechnung 2024",
        {
          document_type: "Nebenkostenabrechnung",
          date_from: "2024-01-01",
          date_to: "2024-12-31",
        },
      ],
    ],
    answerHint:
      "Bei Nebenkostenabrechnungen sind Nachzahlung (oder Guthaben) und Neue Vorauszahlung die häufigsten Antwortgrößen.",
    answerExample:
      "Frage: 'Muss ich für 2024 Nebenkosten nachzahlen?'\nTypenspezifische Felder: Nachzahlung / Guthaben: EUR287.43\n→ 'Du musst für 2024 287,43 € Nebenkosten nachzahlen. [Quelle: 41]'",
  },
  Hausgeldabrechnung: {
    filterExamples: [
      [
        "Hausgeldabrechnung 2023",
        {
          document_type: "Hausgeldabrechnung",
          date_from: "2023-01-01",
          date_to: "2023-12-31",
        },
      ],
    ],
    answerHint:
      "Bei Hausgeldabrechnungen ist 'Nachzahlung / Guthaben (Saldo)' die Endsumme; Hausgeldanteil und Instandhaltungsrücklage geben Detailwerte.",
    answerExample:
      "Frage: 'Wie hoch war mein Hausgeldsaldo 2023?'\nTypenspezifische Felder: Nachzahlung / Guthaben (Saldo): EUR-123.50\n→ 'Du hast 2023 einen Saldo von -123,50 € (Guthaben). [Quelle: 12]'",
  },
  Mahnung: {
    filterExamples: [
      [
        "Mahnungen aus 2025",
        {
          document_type: "Mahnung",
          date_from: "2025-01-01",
          date_to: "2025-12-31",
        },
      ],
    ],
    answerHint:
      "Bei Mahnungen ist 'Gesamtforderung (inkl. Gebühren)' die fällige Summe; Zahlungsfrist nennt den Stichtag.",
    answerExample:
      "Frage: 'Wie hoch ist die offene Mahnforderung?'\nTypenspezifische Felder: Gesamtforderung (inkl. Gebühren): EUR89.50, Zahlungsfrist: 2025-04-15\n→ 'Die offene Mahnforderung beträgt 89,50 €, fällig zum 15.04.2025. [Quelle: 77]'",
  },
  Vertrag: {
    filterExamples: [
      [
        "Verträge im ersten Quartal 2024",
        {
          document_type: "Vertrag",
          date_from: "2024-01-01",
          date_to: "2024-03-31",
        },
      ],
    ],
    answerHint:
      "Bei Verträgen sind Vertragsbeginn, Kündigungsfrist und Vertragsgegenstand die Schlüsselangaben.",
    answerExample:
      "Frage: 'Welche Kündigungsfrist hat mein Mietvertrag?'\nTypenspezifische Felder: Kündigungsfrist: 3 Monate zum Monatsende\n→ 'Dein Mietvertrag hat eine Kündigungsfrist von 3 Monaten zum Monatsende. [Quelle: 5]'",
  },
  Kündigung: {
    filterExamples: [],
    answerHint: "Bei Kündigungen ist 'Wirksamkeit ab' das Schlüssel-Datum.",
    answerExample:
      "Frage: 'Ab wann wirkt meine Kündigung?'\nTypenspezifische Felder: Wirksamkeit ab: 2025-06-30\n→ 'Deine Kündigung wird zum 30.06.2025 wirksam. [Quelle: 31]'",
  },
  Versicherung: {
    filterExamples: [
      [
        "Meine Hausratversicherung",
        {
          document_type: "Versicherung",
          text: "Hausrat",
        },
      ],
    ],
    answerHint:
      "Bei Versicherungen ist 'Jahresprämie' der Beitrag; 'Selbstbeteiligung' und 'Versicherungsart' sind häufige Zusatzfragen.",
    answerExample:
      "Frage: 'Wie viel kostet meine Hausratversicherung im Jahr?'\nTypenspezifische Felder: Jahresprämie: EUR184.20, Versicherungsart: Hausrat\n→ 'Deine Hausratversicherung kostet 184,20 € pro Jahr. [Quelle: 60]'",
  },
  Steuer: {
    filterExamples: [
      [
        "Steuerbescheid 2022",
        {
          document_type: "Steuer",
          date_from: "2022-01-01",
          date_to: "2022-12-31",
        },
      ],
    ],
    answerHint:
      "Bei Steuerdokumenten nennt 'Erstattung / Nachzahlung' den Saldo; Steuerjahr und Steuerart sortieren die Filterantwort.",
    answerExample:
      "Frage: 'Wie hoch war meine Steuererstattung für 2022?'\nTypenspezifische Felder: Erstattung / Nachzahlung: EUR412.00, Steuerjahr: 2022\n→ 'Deine Steuererstattung für 2022 betrug 412,00 €. [Quelle: 99]'",
  },
  Lohnsteuerbescheinigung: {
    filterExamples: [
      [
        "Lohnsteuerbescheinigung 2024",
        {
          document_type: "Lohnsteuerbescheinigung",
          date_from: "2024-01-01",
          date_to: "2024-12-31",
        },
      ],
    ],
    answerHint:
      "Bei Lohnsteuerbescheinigungen sind 'Brutto-Arbeitslohn (Zeile 3)' und 'Einbehaltene Lohnsteuer (Zeile 4)' die Jahressummen.",
    answerExample:
      "Frage: 'Wie viel Lohnsteuer wurde 2024 einbehalten?'\nTypenspezifische Felder: Einbehaltene Lohnsteuer (Zeile 4): EUR8743.21, Brutto-Arbeitslohn (Zeile 3): EUR58420.00\n→ 'Für 2024 wurden 8.743,21 € Lohnsteuer einbehalten (Brutto-Arbeitslohn 58.420,00 €). [Quelle: 71]'",
  },
  Spendenbescheinigung: {
    filterExamples: [],
    answerHint:
      "Bei Spendenbescheinigungen sind 'Spendenbetrag', 'Spendenempfänger' und 'Datum der Zuwendung' die typischen Antwortgrößen.",
    answerExample:
      "Frage: 'Wie hoch war meine Spende an die Tafel 2024?'\nTypenspezifische Felder: Spendenbetrag: EUR120.00, Spendenempfänger (Organisation): Tafel Deutschland e.V., Datum der Zuwendung: 2024-11-12\n→ 'Du hast am 12.11.2024 120,00 € an die Tafel Deutschland e.V. gespendet. [Quelle: 152]'",
  },
  Bescheid: {
    filterExamples: [],
    answerHint:
      "Bei Bescheiden sind Aktenzeichen, Behörde und Widerspruchsfrist die Schlüsselangaben.",
    answerExample:
      "Frage: 'Bis wann kann ich gegen den Bescheid Widerspruch einlegen?'\nTypenspezifische Felder: Widerspruchsfrist: 2025-03-20\n→ 'Du kannst bis zum 20.03.2025 Widerspruch einlegen. [Quelle: 44]'",
  },
  Behördenbrief: {
    filterExamples: [],
    answerHint:
      "Bei Behördenbriefen sind Behörde und Aktenzeichen oft die einzigen strukturierten Angaben — Details stehen meist im Text.",
    answerExample:
      "Frage: 'Welche Behörde hat sich gemeldet?'\nTypenspezifische Felder: Behörde: Bürgeramt Mitte\n→ 'Die Anfrage kommt vom Bürgeramt Mitte. [Quelle: 19]'",
  },
  Sozialversicherungsmeldung: {
    filterExamples: [],
    answerHint:
      "Bei Sozialversicherungsmeldungen sind 'Brutto-Arbeitsentgelt', Beitragszeitraum und Sozialversicherungsnummer die zentralen Felder.",
    answerExample:
      "Frage: 'Wie hoch war mein SV-Brutto 2024?'\nTypenspezifische Felder: Brutto-Arbeitsentgelt: EUR58420.00, Beitragszeitraum von: 2024-01-01, Beitragszeitraum bis: 2024-12-31\n→ 'Dein SV-Brutto für 2024 betrug 58.420,00 €. [Quelle: 64]'",
  },
  Kfz: {
    filterExamples: [["Wann ist die nächste TÜV?", { document_type: "Kfz" }]],
    answerHint:
      "Bei Kfz-Dokumenten sind 'Nächste HU/TÜV', Kennzeichen und VIN die Standardangaben.",
    answerExample:
      "Frage: 'Wann ist die nächste HU?'\nTypenspezifische Felder: Nächste HU/TÜV: 2026-08-15, Kennzeichen: B-XY-1234\n→ 'Die nächste HU für B-XY-1234 ist am 15.08.2026 fällig. [Quelle: 7]'",
  },
  Bußgeldbescheid: {
    filterExamples: [],
    answerHint:
      "Bei Bußgeldbescheiden sind Bußgeld, Tatzeit, Tatbestand und Einspruchsfrist die zentralen Felder.",
    answerExample:
      "Frage: 'Wie hoch ist mein Bußgeld?'\nTypenspezifische Felder: Bußgeld / Verwarnungsgeld: EUR35.00, Tatbestand / Verstoß: 21 km/h zu schnell, Einspruchsfrist: 2025-02-28\n→ 'Dein Bußgeld beträgt 35,00 € (21 km/h zu schnell), Einspruch bis 28.02.2025 möglich. [Quelle: 28]'",
  },
  Arztbrief: {
    filterExamples: [],
    answerHint:
      "Bei Arztbriefen sind Behandlungsdatum, Diagnose und Facharzt die Standardangaben.",
    answerExample:
      "Frage: 'Welche Diagnose stellte Dr. Meier?'\nTypenspezifische Felder: Diagnose: Lumbago, Facharzt / Arzt: Dr. Meier, Behandlungsdatum: 2025-01-08\n→ 'Dr. Meier diagnostizierte am 08.01.2025 Lumbago. [Quelle: 53]'",
  },
  Krankschreibung: {
    filterExamples: [],
    answerHint:
      "Bei Krankschreibungen sind 'Arbeitsunfähig von/bis' und Erst-/Folgebescheinigung die Schlüsselangaben.",
    answerExample:
      "Frage: 'Bis wann bin ich krankgeschrieben?'\nTypenspezifische Felder: Arbeitsunfähig von: 2025-02-10, Arbeitsunfähig bis (voraussichtlich): 2025-02-14\n→ 'Du bist bis voraussichtlich 14.02.2025 krankgeschrieben. [Quelle: 90]'",
  },
  Garantie: {
    filterExamples: [],
    answerHint:
      "Bei Garantien sind Produktname, Kaufdatum und Seriennummer die zentralen Felder.",
    answerExample:
      "Frage: 'Wann habe ich den Geschirrspüler gekauft?'\nTypenspezifische Felder: Produktname: Bosch SMV4HVX33E, Kaufdatum: 2024-04-22, Kaufpreis: EUR589.00\n→ 'Du hast den Bosch SMV4HVX33E am 22.04.2024 für 589,00 € gekauft. [Quelle: 38]'",
  },
  Urkunde: {
    filterExamples: [],
    answerHint:
      "Bei Urkunden ist die Urkundenart die einzige strukturierte Angabe — Details (Namen, Daten) stehen im Text.",
    answerExample:
      "Frage: 'Was für eine Urkunde ist das?'\nTypenspezifische Felder: Urkundenart: Geburtsurkunde\n→ 'Das ist eine Geburtsurkunde. [Quelle: 6]'",
  },
  Ausweis: {
    filterExamples: [
      ["Wann läuft mein Personalausweis ab?", { document_type: "Ausweis" }],
    ],
    answerHint:
      "Bei Ausweisen ist 'Ausstellung' das Ausstellungsdatum (aus den AI-Metadatenfeldern) und 'Ausweisnummer' die Identifikation.",
    answerExample:
      "Frage: 'Wann wurde mein Pass ausgestellt?'\nDokument hat Ausstellung: 2024-05-12\n→ 'Dein Pass wurde am 12.05.2024 ausgestellt. [Quelle: 17]'",
  },
  Zeugnis: {
    filterExamples: [],
    answerHint:
      "Bei Zeugnissen sind Gesamtnote und Aussteller die üblichen Antwortgrößen.",
    answerExample:
      "Frage: 'Welche Gesamtnote hatte ich im Abitur?'\nTypenspezifische Felder: Gesamtnote: 1,8, Aussteller: Gymnasium Beispielstadt\n→ 'Deine Abiturnote war 1,8 (Gymnasium Beispielstadt). [Quelle: 22]'",
  },
  Arbeitszeugnis: {
    filterExamples: [
      ["Mein letztes Arbeitszeugnis", { document_type: "Arbeitszeugnis" }],
    ],
    answerHint:
      "Bei Arbeitszeugnissen sind 'Beschäftigung von/bis', Arbeitgeber und Gesamtbeurteilung die Schlüsselangaben.",
    answerExample:
      "Frage: 'Wie lange habe ich bei Kopfstand gearbeitet?'\nTypenspezifische Felder: Arbeitgeber: Kopfstand GmbH, Beschäftigung von: 2022-03-01, Beschäftigung bis: 2024-12-31\n→ 'Du warst von März 2022 bis Dezember 2024 bei Kopfstand GmbH beschäftigt. [Quelle: 16]'",
  },
  Mitgliedschaft: {
    filterExamples: [],
    answerHint:
      "Bei Mitgliedschaften sind Mitgliedsnummer und Jahresbeitrag die zentralen Felder.",
    answerExample:
      "Frage: 'Wie hoch ist mein Vereinsbeitrag?'\nTypenspezifische Felder: Jahresbeitrag: EUR60.00, Mitgliedsnummer: A-12345\n→ 'Dein Vereinsbeitrag beträgt 60,00 € pro Jahr (Mitgliedsnr. A-12345). [Quelle: 49]'",
  },
  Beleg: {
    filterExamples: [],
    answerHint:
      "Belege bestätigen, dass eine Zahlung erfolgt ist. Zentrale Felder: bezahlter Betrag, Zahlungsart, Belegnummer und bezugnehmende Rechnungsnummer (falls genannt).",
    answerExample:
      "Frage: 'Habe ich die Anthropic-Rechnung bezahlt?'\nTypenspezifische Felder: Bezahlter Betrag: EUR200.00, Zahlungsart: Kreditkarte, Bezugnehmende Rechnungsnummer: INV-2024-03\n→ 'Ja, du hast 200,00 € per Kreditkarte für die Rechnung INV-2024-03 bezahlt. [Quelle: 50]'",
  },
  Sonstiges: {
    filterExamples: [],
    answerHint: "",
    answerExample: "",
  },
};

export function fieldLabelsFor(docType: DocumentType): string[] {
  const fields = TYPE_FIELD_SCHEMA[docType] as
    | readonly { readonly labelDe: string }[]
    | undefined;
  return (fields ?? []).map((f) => f.labelDe);
}

export function moduleFor(docType: DocumentType): DocTypeModule {
  return MODULES[docType];
}

export function parseDocumentType(
  value: string | null | undefined,
): DocumentType | null {
  if (!value) {
    return null;
  }
  return (DOCUMENT_TYPES as readonly string[]).includes(value)
    ? (value as DocumentType)
    : null;
}
