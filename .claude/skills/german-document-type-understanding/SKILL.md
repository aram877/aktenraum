# German Document Type Taxonomy Analysis Module

This skill covers the entire taxonomy of accepted document types in Aktenraum, utilizing the 27 discrete German classifications defined in `aktenraum_core/models/DocumentType`. It governs how documents are processed upon ingestion, reviewed in the Inbox, and finally propagated to native Paperless tags.

## Core Concepts
*   **Taxonomy Source:** The single source of truth for document types is the Python `DocumentType` enum (from `packages/aktenraum-core/src/models/extraction.ts`). Any manual edit to this list should be treated as a feature change and documented via an ADR.
*   **Disambiguation:** The system relies heavily on context clues provided by the LLM's prompt to distinguish between types that sound similar (e.g., `Bescheid` vs. `Behördenbrief`).
*   **Field Mapping:** Each DocumentType must have a unique schema for its key fields (e.g., `Rechnung` requires `gesamtbetrag`, while `Gehaltsabrechnung` requires `brutto_gehalt` and `netto_gehalt`).

## The 27 Types & Critical Gotchas
The specific definitions and mandatory field sets are as follows:

1.  **🟡 Rechnung (Invoice):** Requires sender/receiver, date, line items, and *Gesamtbetrag*. Must distinguish from mere *Beleg* attachments.
    *   🚨 **Gotcha:** The monetary field must be read using the `EUR<amount>` format normaliser from Paperless.
2.  **🟡 Gehaltsabrechnung (Payslip):** Requires specific wage items (`netto`, `brutto`). Crucial for identifying employment history fields during propagation.
3.  **🟡 Kontoauszug (Bank Statement):** Used primarily to extract financial movements and transaction dates, rarely for primary tagging. Highest field extraction volume is expected here.
4.  **🟢 Nebenkostenabrechnung (Utility Cost Statement):** Distinct from general `Rechnung`. Specifically looks for period usage rates and consumption amounts for utility billing cycles.
5.  **🟡 Hausgeldabrechnung (Community Fee Statement):** Used where the document relates to property ownership/management fees (`WEG-Eigentümer`). Distinguish mandatory fees from voluntary payments.
6.  **🔴 Mahnung (Reminder Notice):** Usually follows a failed payment associated with `Rechnung`. Contains the required missing amount and original due date.
7.  **⚫ Vertrag (Contract):** The primary vessel for structural data extraction: contract duration, parties involved, signatures dates (using multi-entity text).
8.  **⚪ Kündigung (Termination Notice):** Contains notices of termination, highly sensitive to effective end dates/dates mentioned in the document body.
9.  **🟡 Versicherung (Insurance):** Focuses on policy numbers (`Policennr.`) and premium amounts (`jahrespraemie`). Must verify validity using the provided `Versicherungsnummer` pattern.
10. **🟢 Steuer / Steuerbescheid:**
    *   `Steuer`: Reserved for tax returns/filing forms (e.g., *Anlagen*).
    *   `Bescheid`: Official decisions from the Finanzamt (`Finanzamt-issued`). The `Steuererklärungen`/§41b certificates are a separate type, **not** part of this classification.
11. **🟡 Lohnsteuerbescheinigung (Wage Tax Certificate):** Specific annual tax certificate (§41b EStG). Must be distinct from general Payslips or other Salary documents to avoid data loss in the `cv_employment_duration` field.
12. **🟢 Spendenbescheinigung:** Official donation receipt (§50 EStDV). Simple tag mapping but highly critical for tax purposes and must not confuse with a Receipt (`Rechnung`).
13. **🔵 Bescheid (Administrative Decision):** Any non-traffic administrative ruling issued by an authority (`Behördenbrief` from the Finanzamt excluding VAT/Tax specific decisions). This is a general error trap category.
14. **⚫ Behördenbrief (Official Authority Letter):** General correspondence or address confirmation from government bodies (Bürgeramt, etc.). Typically textual and less structured than a `Bescheid`.
15. **🟡 Sozialversicherungsmeldung (Social Security Notice - DEÜV §25):** Mandatory annual reporting documents sent by employers to the SHI/DEÜV. *Must* be used instead of general 'Employment' notices.
16. **🟢 Kfz (Vehicle Documents):** Issues related to vehicles (e.g., TÜV papers, registration). Requires specific VIN/license plate pattern recognition.
17. **🟠 Bußgeldbescheid (Traffic Fine Notice):** Exclusively for traffic violations (`Bußgeld`). Never mix with general administrative decisions.
18. **🟢 Arztbrief (Doctor’s Report):** Detailed medical findings, test results, and diagnostic narratives. Prioritize structured data extraction in the medical sub-schema.
19. **🟡 Krankschreibung (Sick Leave Certificate):** Short certificates ("Yellow Slip"). Primary function is date validation: must correctly identify start/end dates of inability to work.
20. **🔴 Garantie (Warranty):** Documents detailing product warranties, usually linking product ID and expiration date.
21. **🟠 Urkunde (Certificate/Charter):** Official documentation of status change or rights transfer (e.g., ownership). Highly formal language style required for prompt crafting.
22. **⚪ Ausweis / Zeugnis / Arbeitszeugnis (Credential Suite):**
    *   `Ausweis`: ID cards and official identification documents (focus on machine-readable data/photos).
    *   `Zeugnis`: General completion certificate (e.g., graduation).
    *   `Arbeitszeugnis`: Employment reference letter. Must extract role, dates, and performance ratings.
23. **⚫ Mitgliedschaft (Membership):** Confirmation of membership in an organization or club. Extracts membership/ID numbers.
24. **⚪ Beleg (Voucher/Receipt):** Generic proof of purchase; often attached to invoices but should be tagged separately if no required `Re Rechnung` data is present (e.g., small cinema ticket).
25. **⚫ Sonstiges (Miscellaneous):** The fall-through category for documents that fail all specific type checks but contain high value information. Use only when necessary, and log the confidence reason.

## Implementation Gotchas & Robustness Rules
1.  **LLM Prompts:** The `SYSTEM_PROMPT` within `tagger.py` must explicitly enumerate these 27 types using German titles to guide the model's choice structure.
2.  **Contextual Ambiguity:** If a document mentions both an employment duration (typical of `Arbeitszeugnis`) and tax amounts (`Lohnsteuerbescheinigung`), the system can logically infer **two different DocumentTypes**, which must be handled by updating core tags/metadata, not just one single type.
3.  **Propagation Goal:** The ultimate goal is NOT to classify, but to propagate extracted data into Paperless's native fields (e.g., a structured date from an `Arztbrief` must map accurately).
4.  **Order of Failure:** When the model fails classification, the fallback should always be **So/Sonstiges**, preventing silent data loss without explicit failure feedback.

## Skill Triggers
*   **Auto-load on edits to:** `services/auto-tagger/src/{prompt,extract,synthesizers}.ts`, `packages/aktenraum-core/src/models/extraction.ts`.
*   **Usage**: When a user needs clarification or rule adherence regarding a German document type before modifying the core logic.