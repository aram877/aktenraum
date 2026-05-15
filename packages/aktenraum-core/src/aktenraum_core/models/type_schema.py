from .extraction import DocumentType, FieldDef

TYPE_FIELD_SCHEMA: dict[DocumentType, list[FieldDef]] = {
    DocumentType.Rechnung: [
        FieldDef("rechnungsnummer", "Rechnungsnummer", "string"),
        FieldDef("gesamtbetrag", "Gesamtbetrag (brutto)", "money"),
        FieldDef("nettobetrag", "Nettobetrag", "money"),
        FieldDef("mwst_satz", "MwSt-Satz", "string"),
        FieldDef("mwst_betrag", "MwSt-Betrag", "money"),
        FieldDef("iban", "IBAN", "string"),
        FieldDef("bestellnummer", "Bestellnummer", "string"),
    ],
    DocumentType.Gehaltsabrechnung: [
        FieldDef("abrechnungsmonat", "Abrechnungsmonat", "month"),
        FieldDef("bruttogehalt", "Bruttogehalt", "money"),
        FieldDef("nettogehalt", "Nettogehalt", "money"),
        FieldDef("steuerklasse", "Steuerklasse", "string"),
        FieldDef("lohnsteuer", "Lohnsteuer", "money"),
        FieldDef("sozialversicherung", "Sozialversicherung", "money"),
    ],
    DocumentType.Kontoauszug: [
        FieldDef("iban", "IBAN", "string"),
        FieldDef("zeitraum_von", "Zeitraum von", "date"),
        FieldDef("zeitraum_bis", "Zeitraum bis", "date"),
        FieldDef("anfangssaldo", "Anfangssaldo", "money"),
        FieldDef("endsaldo", "Endsaldo", "money"),
    ],
    DocumentType.Nebenkostenabrechnung: [
        FieldDef("abrechnungsjahr", "Abrechnungsjahr", "year"),
        FieldDef("nachzahlung", "Nachzahlung / Guthaben", "money"),
        FieldDef("neue_vorauszahlung", "Neue Vorauszahlung", "money"),
        FieldDef("heizkosten", "Heizkosten", "money"),
        FieldDef("betriebskosten", "Betriebskosten", "money"),
    ],
    DocumentType.Mahnung: [
        FieldDef("mahnstufe", "Mahnstufe", "string"),
        FieldDef("ursprungsrechnung", "Ursprüngliche Rechnungsnr.", "string"),
        FieldDef("forderungsbetrag", "Forderungsbetrag (Hauptforderung)", "money"),
        FieldDef("mahngebuehr", "Mahngebühr", "money"),
        FieldDef("gesamtforderung", "Gesamtforderung (inkl. Gebühren)", "money"),
        FieldDef("zahlungsfrist", "Zahlungsfrist", "date"),
    ],
    DocumentType.Vertrag: [
        FieldDef("vertragsnummer", "Vertragsnummer", "string"),
        FieldDef("vertragsbeginn", "Vertragsbeginn", "date"),
        FieldDef("kuendigungsfrist", "Kündigungsfrist", "string"),
        FieldDef("vertragsgegenstand", "Vertragsgegenstand", "string"),
    ],
    DocumentType.Kuendigung: [
        FieldDef("vertragsreferenz", "Vertragsreferenz", "string"),
        FieldDef("wirksamkeitsdatum", "Wirksamkeit ab", "date"),
    ],
    DocumentType.Versicherung: [
        FieldDef("versicherungsnummer", "Versicherungsnummer", "string"),
        FieldDef("versicherungsart", "Versicherungsart", "string"),
        FieldDef("jahrespraemie", "Jahresprämie", "money"),
        FieldDef("selbstbeteiligung", "Selbstbeteiligung", "money"),
    ],
    DocumentType.Steuer: [
        FieldDef("steuerjahr", "Steuerjahr", "year"),
        FieldDef("steuerart", "Steuerart", "string"),
        FieldDef("steuernummer", "Steuernummer", "string"),
        FieldDef("erstattung", "Erstattung / Nachzahlung", "money"),
    ],
    DocumentType.Lohnsteuerbescheinigung: [
        FieldDef("bescheinigungsjahr", "Bescheinigungsjahr", "year"),
        FieldDef(
            "steueridentifikationsnummer",
            "Steuer-Identifikationsnummer (11-stellig)",
            "string",
        ),
        FieldDef("steuerklasse", "Steuerklasse (1–6)", "string"),
        FieldDef("brutto_arbeitslohn", "Brutto-Arbeitslohn (Zeile 3)", "money"),
        FieldDef("lohnsteuer", "Einbehaltene Lohnsteuer (Zeile 4)", "money"),
        FieldDef("kirchensteuer", "Kirchensteuer", "money"),
        FieldDef("finanzamt", "Zuständiges Finanzamt", "string"),
    ],
    DocumentType.Bescheid: [
        FieldDef("aktenzeichen", "Aktenzeichen", "string"),
        FieldDef("behoerde", "Behörde", "string"),
        FieldDef("widerspruchsfrist", "Widerspruchsfrist", "date"),
    ],
    DocumentType.Behoerdenbrief: [
        FieldDef("aktenzeichen", "Aktenzeichen", "string"),
        FieldDef("behoerde", "Behörde", "string"),
    ],
    DocumentType.Sozialversicherungsmeldung: [
        FieldDef("beitragszeitraum_von", "Beitragszeitraum von", "date"),
        FieldDef("beitragszeitraum_bis", "Beitragszeitraum bis", "date"),
        FieldDef("brutto_entgelt", "Brutto-Arbeitsentgelt", "money"),
        FieldDef(
            "beitragspflichtiges_entgelt", "Beitragspflichtiges Entgelt", "money"
        ),
        FieldDef(
            "sozialversicherungsnummer", "Sozialversicherungsnummer (RV-Nr.)", "string"
        ),
        FieldDef("betriebsnummer", "Betriebsnummer des Arbeitgebers", "string"),
    ],
    DocumentType.Kfz: [
        FieldDef("kennzeichen", "Kennzeichen", "string"),
        FieldDef("vin", "Fahrgestellnummer (VIN)", "string"),
        FieldDef("marke_modell", "Marke / Modell", "string"),
        FieldDef("naechste_hu", "Nächste HU/TÜV", "date"),
    ],
    DocumentType.Arztbrief: [
        FieldDef("behandlungsdatum", "Behandlungsdatum", "date"),
        FieldDef("diagnose", "Diagnose", "string"),
        FieldDef("facharzt", "Facharzt / Arzt", "string"),
    ],
    DocumentType.Garantie: [
        FieldDef("produktname", "Produktname", "string"),
        FieldDef("seriennummer", "Seriennummer", "string"),
        FieldDef("kaufdatum", "Kaufdatum", "date"),
        FieldDef("kaufpreis", "Kaufpreis", "money"),
    ],
    DocumentType.Urkunde: [
        FieldDef("urkundenart", "Urkundenart", "string"),
    ],
    DocumentType.Ausweis: [
        FieldDef("ausweisnummer", "Ausweisnummer", "string"),
        FieldDef("ausstellendes_amt", "Ausstellendes Amt", "string"),
    ],
    DocumentType.Zeugnis: [
        FieldDef("aussteller", "Aussteller", "string"),
        FieldDef("note_gesamt", "Gesamtnote", "string"),
    ],
    DocumentType.Arbeitszeugnis: [
        FieldDef("arbeitgeber", "Arbeitgeber", "string"),
        FieldDef("zeitraum_von", "Beschäftigung von", "date"),
        FieldDef("zeitraum_bis", "Beschäftigung bis", "date"),
        FieldDef("beurteilung", "Gesamtbeurteilung", "string"),
    ],
    DocumentType.Mitgliedschaft: [
        FieldDef("mitgliedsnummer", "Mitgliedsnummer", "string"),
        FieldDef("jahresbeitrag", "Jahresbeitrag", "money"),
    ],
    DocumentType.Sonstiges: [],
}
