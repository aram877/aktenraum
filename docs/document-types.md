# Document type reference

27 German document types. The auto-tagger picks one per document on
extraction; pass 2 then extracts type-specific structured fields based
on the choice. Both the enum and per-type fields are canonical at
[`packages/aktenraum-core/src/aktenraum_core/models/`](../packages/aktenraum-core/src/aktenraum_core/models/) —
this doc explains *why* each type exists, the disambiguation rules
that keep them separate, and the fields you'll see in the SPA's
"Type-specific" section.

For the prompt-side definitions and templates, see `SYSTEM_PROMPT` in
[`services/auto-tagger/src/auto_tagger/tagger.py`](../services/auto-tagger/src/auto_tagger/tagger.py).

---

## How classification works

1. The auto-tagger sends the OCR'd text to the LLM with a system prompt
   that lists every type with a one-line definition and disambiguation
   notes. The model returns a `DocumentExtraction` JSON.
2. Pydantic validates the response; `document_type` must match one of
   the enum values exactly. Anything outside the enum fails extraction
   and tags `ai-error`.
3. Pass 2 looks up the per-type field schema and re-prompts the LLM
   for those fields. Results go to the `aktenraum` database (not
   Paperless's custom fields), keyed by document id.
4. The user can correct the type in the inbox or library detail view.
   Saving the type doesn't re-run pass 2 by itself — click **Erneut
   verarbeiten** to re-extract both passes against the current model.

---

## The 27 types

Grouped by life area so you can find them by what they're about, not by
alphabet. The "Aliases" column lists the German names a user might call
the document — these are not strict synonyms in the enum but signals the
prompt's disambiguation rules recognise.

### Financial / commercial

| Type | Definition | Aliases / signals |
|---|---|---|
| **Rechnung** | Invoices that ask for payment for goods or services (not insurance, not authority). | Rechnung |
| **Beleg** | Proof a payment was made — Quittung, Kassenbon, Zahlungsbestätigung, PayPal/Kreditkarten-Abrechnungsbeleg. Distinct from Rechnung (which asks for payment) and from Kontoauszug (which lists many transactions). | Quittung, Kassenbon, Zahlungsbeleg |
| **Mahnung** | Payment reminder, dunning letter, Inkassoschreiben, Vollstreckungsbescheid. | Zahlungserinnerung, Mahnbescheid |
| **Kontoauszug** | Bank, credit-card, brokerage, savings statements. | Kontoauszug, Depotauszug |
| **Vertrag** | Employment, rental, purchase, services, loan agreements. | Arbeitsvertrag, Mietvertrag, Darlehensvertrag |
| **Kündigung** | Termination letters and contract revocations. | Kündigungsschreiben, Widerruf |
| **Versicherung** | Insurance policies, coverage confirmations, claim regulation. | Police, Versicherungsschein |
| **Garantie** | Warranty/guarantee certificates for products. | Garantieurkunde, Gewährleistungsnachweis |
| **Mitgliedschaft** | GEZ, sports club, ADAC, gym, streaming subscriptions. | Mitgliedsbeitrag, Vereinsbeitrag |

### Employment & social insurance

| Type | Definition | Notes |
|---|---|---|
| **Gehaltsabrechnung** | Monthly payslip / Bezügemitteilung / pension payout. | NOT the annual §41b certificate — that's its own type. |
| **Lohnsteuerbescheinigung** | The employer's annual §41b EStG certificate ("Ausdruck der Elektronischen Lohnsteuerbescheinigung"). | NOT a Gehaltsabrechnung (monthly), NOT a Bescheid (Finanzamt-issued). |
| **Sozialversicherungsmeldung** | Annual DEÜV §25 Meldebescheinigung zur Sozialversicherung; SV-Meldung. | NOT the Bürgeramt's Einwohnermeldebescheinigung (that's `Behördenbrief`). |
| **Arbeitszeugnis** | Reference letters from employers (Zwischenzeugnis, Endzeugnis). | Distinct from school certificates → `Zeugnis`. |

### Health

| Type | Definition | Notes |
|---|---|---|
| **Arztbrief** | Longer medical reports, lab results, referrals, hospital discharge letters, prescriptions. | The full clinical report flavour. |
| **Krankschreibung** | The short AU-Bescheinigung ("gelber Schein") submitted to the employer. | NOT a medical report — if it's a multi-page diagnosis, it's `Arztbrief`. |

### Housing

| Type | Definition | Notes |
|---|---|---|
| **Nebenkostenabrechnung** | Tenant-side utility/operating-cost annual statement from the landlord. | NOT a Hausgeldabrechnung. NOT a Wohngeldbescheid (that's `Bescheid`). |
| **Hausgeldabrechnung** | WEG-Eigentümer annual statement from the Hausverwaltung. | The owner-side counterpart to Nebenkostenabrechnung. |

### Vehicles & traffic

| Type | Definition | Notes |
|---|---|---|
| **Kfz** | Vehicle registration, TÜV/HU report, Kfz-Steuer — non-violation vehicle docs. | NOT a Bußgeldbescheid. |
| **Bußgeldbescheid** | Traffic fine / warning notice (also Anhörungsbogen). | Split off from `Bescheid` so the SPA can show traffic-specific fields. |

### Authority / official

| Type | Definition | Notes |
|---|---|---|
| **Bescheid** | Administrative decisions with legal effect — tax assessment, pension award, BAföG, approval/rejection notices. | NOT a Bußgeldbescheid. |
| **Behördenbrief** | Authority correspondence without Bescheid character — info letters, registration confirmation, Einwohnermeldebescheinigung. | The Bürgeramt's address confirmation lives here. |
| **Spendenbescheinigung** | Charity donation receipt (Zuwendungsbestätigung nach §50 EStDV). | Distinct from Rechnung, Mitgliedschaft, your own Steuer filing. |
| **Steuer** | Tax returns and supporting forms (Anlage N/V/KAP), tax certifications. | NOT the Lohnsteuerbescheinigung (own type), NOT the Steuerbescheid (that's `Bescheid`). |

### Identity & life events

| Type | Definition | Notes |
|---|---|---|
| **Urkunde** | Birth, marriage, death certificates, apostilles, notarised documents. | |
| **Ausweis** | Scans of national ID, passport, driving licence, health insurance card, disability pass. | |
| **Zeugnis** | School certificates, university degrees, vocational diplomas, language certificates (TELC, Goethe). | NOT an Arbeitszeugnis. |

### Catch-all

| Type | Definition | Notes |
|---|---|---|
| **Sonstiges** | Only when nothing else fits — CVs, internal notes, photos. | Pass 2 skips this type — no schema. |

---

## Disambiguation rules that have bitten us

These are encoded directly in `SYSTEM_PROMPT`. Touch them carefully —
each one represents a real misclassification we saw in production.

1. **Meldebescheinigung has two flavours.** The employer's annual SV
   meldung (`Sozialversicherungsmeldung`) vs the Bürgeramt's address
   confirmation (`Behördenbrief`). Keyword: "zur Sozialversicherung" →
   SV-meldung.
2. **Lohnsteuerbescheinigung is not Steuer.** §41b EStG certificate is
   its own type. `Steuer` is for *your* tax filing; `Bescheid` is for
   the Finanzamt's response.
3. **Hausgeldabrechnung vs Nebenkostenabrechnung.** Hausverwaltung →
   Eigentümer is `Hausgeldabrechnung`. Landlord → tenant is
   `Nebenkostenabrechnung`. Housing-benefit notice (Wohngeldbescheid)
   from the Wohngeldstelle is `Bescheid`.
4. **Bußgeldbescheid is its own type.** `Bescheid` is reserved for
   non-traffic administrative acts.
5. **Krankschreibung is not Arztbrief.** Short AU-Bescheinigung ("gelber
   Schein") with date range goes to Krankschreibung; long clinical
   reports stay in Arztbrief.
6. **Spendenbescheinigung is not Rechnung.** Even though it shows a
   sum + recipient, the §50 EStDV character makes it a tax-relevant
   doc with different fields than an invoice.
7. **Beleg is not Rechnung.** A Rechnung *asks* for payment ("Bitte
   überweisen Sie …"); a Beleg *confirms* a payment was made (Quittung,
   Kassenbon, PayPal-Bestätigung). Same vendor on the same day for the
   same amount is the canonical Rechnung+Beleg pair — the type
   discriminator is what stops the duplicate-detection helper from
   flagging that pair.

---

## Type-specific (pass 2) fields

Schemas live in
[`packages/aktenraum-core/src/aktenraum_core/models/type_schema.py`](../packages/aktenraum-core/src/aktenraum_core/models/type_schema.py).
Field types: `string`, `date`, `month`, `year`, `money`.

### Rechnung
`rechnungsnummer` · `gesamtbetrag` (money) · `nettobetrag` (money) ·
`mwst_satz` · `mwst_betrag` (money) · `iban` · `bestellnummer`

### Beleg
`belegnummer` · `gesamtbetrag` (money) · `zahlungsart` ·
`bezogene_rechnung`

### Gehaltsabrechnung
`abrechnungsmonat` (month) · `bruttogehalt` (money) · `nettogehalt` (money) ·
`steuerklasse` · `lohnsteuer` (money) · `sozialversicherung` (money)

### Kontoauszug
`iban` · `zeitraum_von` (date) · `zeitraum_bis` (date) ·
`anfangssaldo` (money) · `endsaldo` (money)

### Nebenkostenabrechnung
`abrechnungsjahr` (year) · `nachzahlung` (money) ·
`neue_vorauszahlung` (money) · `heizkosten` (money) ·
`betriebskosten` (money)

### Hausgeldabrechnung
`wirtschaftsjahr` (year) · `verwalter` · `hausgeldanteil` (money) ·
`instandhaltungsruecklage` (money) · `nachzahlung_oder_guthaben` (money)

### Mahnung
`mahnstufe` · `ursprungsrechnung` · `forderungsbetrag` (money) ·
`mahngebuehr` (money) · `gesamtforderung` (money) ·
`zahlungsfrist` (date)

### Vertrag
`vertragsnummer` · `vertragsbeginn` (date) · `kuendigungsfrist` ·
`vertragsgegenstand`

### Kündigung
`vertragsreferenz` · `wirksamkeitsdatum` (date)

### Versicherung
`versicherungsnummer` · `versicherungsart` · `jahrespraemie` (money) ·
`selbstbeteiligung` (money)

### Steuer
`steuerjahr` (year) · `steuerart` · `steuernummer` ·
`erstattung` (money)

### Lohnsteuerbescheinigung
`bescheinigungsjahr` (year) · `steueridentifikationsnummer` ·
`steuerklasse` · `brutto_arbeitslohn` (money) · `lohnsteuer` (money) ·
`kirchensteuer` (money) · `finanzamt`

### Spendenbescheinigung
`empfaenger` · `spendendatum` (date) · `spendenbetrag` (money) ·
`verwendungszweck` · `steuerbeguenstigt`

### Bescheid
`aktenzeichen` · `behoerde` · `widerspruchsfrist` (date)

### Behördenbrief
`aktenzeichen` · `behoerde`

### Sozialversicherungsmeldung
`beitragszeitraum_von` (date) · `beitragszeitraum_bis` (date) ·
`brutto_entgelt` (money) · `beitragspflichtiges_entgelt` (money) ·
`sozialversicherungsnummer` · `betriebsnummer`

### Kfz
`kennzeichen` · `vin` · `marke_modell` · `naechste_hu` (date)

### Bußgeldbescheid
`tatzeit` (date) · `tatort` · `kennzeichen` · `tatbestand` ·
`bussgeld` (money) · `punkte` · `einspruchsfrist` (date)

### Arztbrief
`behandlungsdatum` (date) · `diagnose` · `facharzt`

### Krankschreibung
`au_von` (date) · `au_bis` (date) · `erstbescheinigung` ·
`arzt_oder_praxis` · `icd10`

### Garantie
`produktname` · `seriennummer` · `kaufdatum` (date) · `kaufpreis` (money)

### Urkunde
`urkundenart`

### Ausweis
`ausweisnummer` · `ausstellendes_amt`

### Zeugnis
`aussteller` · `note_gesamt`

### Arbeitszeugnis
`arbeitgeber` · `zeitraum_von` (date) · `zeitraum_bis` (date) ·
`beurteilung`

### Mitgliedschaft
`mitgliedsnummer` · `jahresbeitrag` (money)

### Sonstiges
*(empty — pass 2 is skipped)*

---

## Adding a new type

If you discover a category that doesn't fit:

1. Add the enum value in [`packages/aktenraum-core/src/aktenraum_core/models/extraction.py`](../packages/aktenraum-core/src/aktenraum_core/models/extraction.py)
   `DocumentType`. The string value is what the LLM emits and what's
   stored in Paperless's `ai_document_type` custom field — keep it
   identical to the conventional German name.
2. Add an entry to `TYPE_FIELD_SCHEMA` in
   [`type_schema.py`](../packages/aktenraum-core/src/aktenraum_core/models/type_schema.py).
   Empty list means "no pass 2".
3. Edit `SYSTEM_PROMPT` in
   [`services/auto-tagger/src/auto_tagger/tagger.py`](../services/auto-tagger/src/auto_tagger/tagger.py):
   add a one-line definition, a title template (e.g. "Foo {Bar}
   {Monat Jahr}"), and any disambiguation note that prevents
   misclassification against existing types.
4. Add a route to the SPA's doc-type select (`InboxReview.tsx`,
   `LibraryReview.tsx`) — both files hard-code `DOC_TYPES` arrays.
5. Run `uv run pytest` — the test suite asserts the enum and the
   schema map stay in sync.
6. Mention the new type in this doc and in `CLAUDE.md` (the taxonomy
   section, with disambiguation rules if any).
