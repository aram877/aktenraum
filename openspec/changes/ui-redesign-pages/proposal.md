# Proposal

## Why

`ui-redesign-foundation` gave the library, the review tab, the detail pages and the navigation the approved editorial look, and `dark-mode` + the "Stapel" logo followed. Every other page still has the old layout (small sans headings, `rounded-lg` boxes, ad-hoc button styles). They only picked up the new colours and fonts, so moving between pages feels like two different apps. The maintainer asked to continue the redesign across the remaining pages on 2026-11-22.

## What Changes

- **Shared building blocks**:
  - `components/PageHeader.vue`: eyebrow, serif title, subtitle, and an actions slot. Same rhythm as the library header.
  - Component classes in `main.css`: `.card`, `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-danger`, `.field`, `.label-caps`, `.page` / `.page-narrow`. Pages stop repeating long class strings.
- **Home (Übersicht)**:
  - A greeting header and a question box that sends you to Ask.
  - Four stat cards: zur Prüfung, in Bearbeitung, Fehler, neu in 24 h.
  - The newest documents as compact rows with type tiles.
  - The 9 areas with their counts, each linking to the filtered library.
  - The dead "Dokument scannen" card goes (`/scan` was removed in ADR-006).
- **Ask**: a large question field with suggestions, the answer on a paper card with a serif lead, and citations as rows with type tiles.
- **Upload**: a large dropzone card; per-file rows with a progress state.
- **Activity, Papierkorb, Geteilt**: page header, rows with type tiles where a document type is known, cards for summaries.
- **Akten**: page header and cards per Akte.
- **Settings**: page header, a sticky section index on wide screens, every section as a card with a serif heading.
- **Smaller pages** (enrol, health, not found): page header / card styling.
- No change to data, routes, test IDs or German copy that tests rely on.

## Non-goals

- New features on these pages beyond the home dashboard composition (all of its data comes from existing endpoints).
- Redesigning Paperless's own UI.
