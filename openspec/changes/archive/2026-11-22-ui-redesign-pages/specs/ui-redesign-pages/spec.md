# Spec Delta

## Purpose

How every top-level page of the SPA presents itself in the editorial design, and what the home page shows.

## ADDED Requirements

### Requirement: Every top-level page uses the shared page header
Home, Ask, Upload, Aktivität, Papierkorb, Geteilt, Akten and Einstellungen SHALL open with the shared page header (eyebrow, serif title, optional subtitle and actions).

#### Scenario: consistent header
- **WHEN** the user opens any of these pages
- **THEN** the title is set in the serif heading style used by the library

### Requirement: The home page summarises the archive
The home page SHALL show the number of documents waiting for review, in processing, with errors and imported in the last 24 hours, the newest documents with their type tiles, and every area that has documents with its count, linking to the library filtered by that area. It SHALL NOT link to removed pages.

#### Scenario: area link
- **WHEN** the user clicks the area "Geld" on the home page
- **THEN** the library opens with `?family=geld`

#### Scenario: no scan card
- **WHEN** the home page renders
- **THEN** there is no link to `/scan`

### Requirement: Document lists show the type tile
Ask citations, Papierkorb rows and the home page's newest documents SHALL show the document type tile next to the title. (Geteilt entries carry no document type, so they show none.)

#### Scenario: citation
- **WHEN** an answer cites a Rechnung
- **THEN** its citation row shows the Geld tile with the code "RE"
