import type { DocumentType } from "./extraction.js";

export type FieldType = "string" | "money" | "date" | "month" | "year";

export interface FieldDef {
  readonly name: string;
  readonly labelDe: string;
  readonly fieldType: FieldType;
}

function f(name: string, labelDe: string, fieldType: FieldType): FieldDef {
  return Object.freeze({ name, labelDe, fieldType });
}

export const TYPE_FIELD_SCHEMA: Readonly<Record<DocumentType, readonly FieldDef[]>> =
  Object.freeze({
    Rechnung: [
      f("rechnungsnummer", "Rechnungsnummer", "string"),
      f("gesamtbetrag", "Gesamtbetrag (brutto)", "money"),
      f("nettobetrag", "Nettobetrag", "money"),
      f("mwst_satz", "MwSt-Satz", "string"),
      f("mwst_betrag", "MwSt-Betrag", "money"),
      f("iban", "IBAN", "string"),
      f("bestellnummer", "Bestellnummer", "string"),
    ],
    Gehaltsabrechnung: [
      f("abrechnungsmonat", "Abrechnungsmonat", "month"),
      f("bruttogehalt", "Bruttogehalt", "money"),
      f("nettogehalt", "Nettogehalt", "money"),
      f("steuerklasse", "Steuerklasse", "string"),
      f("lohnsteuer", "Lohnsteuer", "money"),
      f("sozialversicherung", "Sozialversicherung", "money"),
    ],
    Kontoauszug: [
      f("iban", "IBAN", "string"),
      f("zeitraum_von", "Zeitraum von", "date"),
      f("zeitraum_bis", "Zeitraum bis", "date"),
      f("anfangssaldo", "Anfangssaldo", "money"),
      f("endsaldo", "Endsaldo", "money"),
    ],
    Nebenkostenabrechnung: [
      f("abrechnungsjahr", "Abrechnungsjahr", "year"),
      f("nachzahlung", "Nachzahlung / Guthaben", "money"),
      f("neue_vorauszahlung", "Neue Vorauszahlung", "money"),
      f("heizkosten", "Heizkosten", "money"),
      f("betriebskosten", "Betriebskosten", "money"),
    ],
    Hausgeldabrechnung: [
      f("wirtschaftsjahr", "Wirtschaftsjahr", "year"),
      f("verwalter", "Hausverwaltung", "string"),
      f("hausgeldanteil", "Hausgeldanteil (umlagefähig + nicht-umlagefähig)", "money"),
      f("instandhaltungsruecklage", "Zuführung Instandhaltungsrücklage", "money"),
      f("nachzahlung_oder_guthaben", "Nachzahlung / Guthaben (Saldo)", "money"),
    ],
    Mahnung: [
      f("mahnstufe", "Mahnstufe", "string"),
      f("ursprungsrechnung", "Ursprüngliche Rechnungsnr.", "string"),
      f("forderungsbetrag", "Forderungsbetrag (Hauptforderung)", "money"),
      f("mahngebuehr", "Mahngebühr", "money"),
      f("gesamtforderung", "Gesamtforderung (inkl. Gebühren)", "money"),
      f("zahlungsfrist", "Zahlungsfrist", "date"),
    ],
    Vertrag: [
      f("vertragsnummer", "Vertragsnummer", "string"),
      f("vertragsbeginn", "Vertragsbeginn", "date"),
      f("kuendigungsfrist", "Kündigungsfrist", "string"),
      f("vertragsgegenstand", "Vertragsgegenstand", "string"),
    ],
    "Kündigung": [
      f("vertragsreferenz", "Vertragsreferenz", "string"),
      f("wirksamkeitsdatum", "Wirksamkeit ab", "date"),
    ],
    Versicherung: [
      f("versicherungsnummer", "Versicherungsnummer", "string"),
      f("versicherungsart", "Versicherungsart", "string"),
      f("jahrespraemie", "Jahresprämie", "money"),
      f("selbstbeteiligung", "Selbstbeteiligung", "money"),
    ],
    Steuer: [
      f("steuerjahr", "Steuerjahr", "year"),
      f("steuerart", "Steuerart", "string"),
      f("steuernummer", "Steuernummer", "string"),
      f("erstattung", "Erstattung / Nachzahlung", "money"),
    ],
    Lohnsteuerbescheinigung: [
      f("bescheinigungsjahr", "Bescheinigungsjahr", "year"),
      f("steueridentifikationsnummer", "Steuer-Identifikationsnummer (11-stellig)", "string"),
      f("steuerklasse", "Steuerklasse (1–6)", "string"),
      f("brutto_arbeitslohn", "Brutto-Arbeitslohn (Zeile 3)", "money"),
      f("lohnsteuer", "Einbehaltene Lohnsteuer (Zeile 4)", "money"),
      f("kirchensteuer", "Kirchensteuer", "money"),
      f("finanzamt", "Zuständiges Finanzamt", "string"),
    ],
    Spendenbescheinigung: [
      f("empfaenger", "Spendenempfänger (Organisation)", "string"),
      f("spendendatum", "Datum der Zuwendung", "date"),
      f("spendenbetrag", "Spendenbetrag", "money"),
      f("verwendungszweck", "Verwendungszweck / Förderzweck", "string"),
      f("steuerbeguenstigt", "Steuerbegünstigung (anerkannt / Vereinszweck)", "string"),
    ],
    Bescheid: [
      f("aktenzeichen", "Aktenzeichen", "string"),
      f("behoerde", "Behörde", "string"),
      f("widerspruchsfrist", "Widerspruchsfrist", "date"),
    ],
    "Behördenbrief": [
      f("aktenzeichen", "Aktenzeichen", "string"),
      f("behoerde", "Behörde", "string"),
    ],
    Sozialversicherungsmeldung: [
      f("beitragszeitraum_von", "Beitragszeitraum von", "date"),
      f("beitragszeitraum_bis", "Beitragszeitraum bis", "date"),
      f("brutto_entgelt", "Brutto-Arbeitsentgelt", "money"),
      f("beitragspflichtiges_entgelt", "Beitragspflichtiges Entgelt", "money"),
      f("sozialversicherungsnummer", "Sozialversicherungsnummer (RV-Nr.)", "string"),
      f("betriebsnummer", "Betriebsnummer des Arbeitgebers", "string"),
    ],
    Kfz: [
      f("kennzeichen", "Kennzeichen", "string"),
      f("vin", "Fahrgestellnummer (VIN)", "string"),
      f("marke_modell", "Marke / Modell", "string"),
      f("naechste_hu", "Nächste HU/TÜV", "date"),
    ],
    "Bußgeldbescheid": [
      f("tatzeit", "Tatzeit / Tatdatum", "date"),
      f("tatort", "Tatort", "string"),
      f("kennzeichen", "Kennzeichen", "string"),
      f("tatbestand", "Tatbestand / Verstoß", "string"),
      f("bussgeld", "Bußgeld / Verwarnungsgeld", "money"),
      f("punkte", "Punkte in Flensburg", "string"),
      f("einspruchsfrist", "Einspruchsfrist", "date"),
    ],
    Arztbrief: [
      f("behandlungsdatum", "Behandlungsdatum", "date"),
      f("diagnose", "Diagnose", "string"),
      f("facharzt", "Facharzt / Arzt", "string"),
    ],
    Krankschreibung: [
      f("au_von", "Arbeitsunfähig von", "date"),
      f("au_bis", "Arbeitsunfähig bis (voraussichtlich)", "date"),
      f("erstbescheinigung", "Erstbescheinigung (ja) oder Folgebescheinigung (nein)", "string"),
      f("arzt_oder_praxis", "Arzt / Praxis", "string"),
      f("icd10", "ICD-10-Diagnose", "string"),
    ],
    Garantie: [
      f("produktname", "Produktname", "string"),
      f("seriennummer", "Seriennummer", "string"),
      f("kaufdatum", "Kaufdatum", "date"),
      f("kaufpreis", "Kaufpreis", "money"),
    ],
    Urkunde: [f("urkundenart", "Urkundenart", "string")],
    Ausweis: [
      f("ausweisnummer", "Ausweisnummer", "string"),
      f("ausstellendes_amt", "Ausstellendes Amt", "string"),
    ],
    Zeugnis: [
      f("aussteller", "Aussteller", "string"),
      f("note_gesamt", "Gesamtnote", "string"),
    ],
    Arbeitszeugnis: [
      f("arbeitgeber", "Arbeitgeber", "string"),
      f("zeitraum_von", "Beschäftigung von", "date"),
      f("zeitraum_bis", "Beschäftigung bis", "date"),
      f("beurteilung", "Gesamtbeurteilung", "string"),
    ],
    Mitgliedschaft: [
      f("mitgliedsnummer", "Mitgliedsnummer", "string"),
      f("jahresbeitrag", "Jahresbeitrag", "money"),
    ],
    Beleg: [
      f("belegnummer", "Belegnummer / Transaktions-Nr.", "string"),
      f("gesamtbetrag", "Bezahlter Betrag", "money"),
      f("zahlungsart", "Zahlungsart (z.B. Kreditkarte, PayPal, Bar)", "string"),
      f("bezogene_rechnung", "Bezugnehmende Rechnungsnummer (falls genannt)", "string"),
    ],
    Sonstiges: [],
  });
