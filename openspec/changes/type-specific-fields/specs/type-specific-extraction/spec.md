## ADDED Requirements

### Requirement: Second-pass type-specific extraction
After the generic extraction pass completes and a `document_type` other than `Sonstiges` is resolved, the auto-tagger SHALL run a second LLM extraction pass using a short, type-focused prompt that requests only the fields defined in the schema registry for that document type. The result SHALL be persisted to the aktenraum DB via `PATCH /api/documents/{id}/type-fields`. Pass 2 failure SHALL be logged and SHALL NOT affect the document's lifecycle tags.

#### Scenario: Pass 2 runs for a known type
- **WHEN** pass 1 resolves `document_type = Rechnung`
- **THEN** the auto-tagger runs a second LLM call with a Rechnung-specific prompt and POSTs the result to aktenraum-api

#### Scenario: Pass 2 skipped for Sonstiges
- **WHEN** pass 1 resolves `document_type = Sonstiges`
- **THEN** no second LLM call is made and no `document_type_fields` row is written

#### Scenario: Pass 2 failure does not block lifecycle
- **WHEN** the aktenraum-api is unreachable during pass 2
- **THEN** the error is logged, the document's lifecycle tag (ai-pending or ai-approved) is set normally by pass 1 routing, and the document is visible in the inbox for review

### Requirement: Type-specific prompt structure
The `build_type_specific_prompt(doc_type, content)` function in `aktenraum-core` SHALL produce a prompt that: states the document type in German, lists each schema field with its type and a one-line German description, instructs the LLM to return a JSON object with exactly those keys (null for fields not found), and includes the OCR-fragment awareness rule (spaced numbers, German date formats).

#### Scenario: Prompt contains only the fields for the given type
- **WHEN** `build_type_specific_prompt(DocumentType.Rechnung, content)` is called
- **THEN** the returned prompt string contains `rechnungsnummer`, `nettobetrag`, `mwst_satz`, `mwst_betrag`, `iban`, `bestellnummer` and no fields from other types

#### Scenario: Prompt requests null for missing fields
- **WHEN** the LLM cannot find a field value in the document text
- **THEN** the LLM SHALL return `null` for that key and the system SHALL store it as absent (not written to the JSONB object)

### Requirement: Schema registry defines type-specific fields
The `TYPE_FIELD_SCHEMA` constant in `aktenraum-core` SHALL map each `DocumentType` to a list of `FieldDef(name, label_de, field_type)` where `field_type` is one of `string | money | date | month | year`. `Sonstiges` SHALL map to an empty list.

#### Scenario: All 20 document types present in schema
- **WHEN** the schema registry is loaded
- **THEN** every value in the `DocumentType` enum has an entry (empty list is valid for Sonstiges)

#### Scenario: FieldDef is complete
- **WHEN** a FieldDef is accessed
- **THEN** it has a non-empty `name` (snake_case), a non-empty `label_de` (German display label), and a valid `field_type`

### Requirement: Normalisation on type-specific field write
The `PATCH /api/documents/{id}/type-fields` handler SHALL normalise values before storing: `money` fields via `_normalize_monetary`, `date` fields via `_normalize_date`, `month` fields to `YYYY-MM`, `year` fields to a 4-digit string, `string` fields stripped of leading/trailing whitespace and truncated at 500 characters. `null` values SHALL be stored as absent (key omitted from JSONB).

#### Scenario: Money field normalised
- **WHEN** `nettobetrag` is patched with `"42,00 EUR"`
- **THEN** the stored value is `"EUR42.00"`

#### Scenario: Date field normalised
- **WHEN** `zeitraum_von` is patched with `"01.03.2024"`
- **THEN** the stored value is `"2024-03-01"`

#### Scenario: Null field omitted
- **WHEN** a field value is `null` in the patch body
- **THEN** the key is removed from the JSONB object (not stored as null)
