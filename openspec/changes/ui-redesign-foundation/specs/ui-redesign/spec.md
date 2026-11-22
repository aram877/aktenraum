# Spec Delta

## Purpose

How the SPA shows document types, how the library list stays compact and scannable, and how a user filters it by area.

## ADDED Requirements

### Requirement: Every document type has a distinct visual identity
The SPA SHALL map each of the 27 document types to one of 9 areas and show it as a tile with the area's colour, the type's icon and its 2-letter code, in every library row, review row and detail header. A missing or unknown type SHALL show as Sonstiges.

#### Scenario: known type
- **WHEN** a library row has the document type "Bußgeldbescheid"
- **THEN** its tile shows the Mobilität colour and the code "BG"

#### Scenario: unknown type
- **WHEN** a row has no document type
- **THEN** its tile shows the Sonstiges colour and the code "SO"

### Requirement: Library rows stay compact
A library row SHALL show the title, a line with type and correspondent, the date, a ★ when the document is marked `wichtig`, a single "+N" chip for its other user-facing tags (full list as a tooltip), and a status label only when the state needs attention (error, pending review, low confidence, transferring, in progress).

#### Scenario: many tags
- **WHEN** a document has the tags `wichtig`, `Strom`, `Wohnung`, `2026`
- **THEN** its row shows "★" and "+3", and not the tag names

#### Scenario: finished document
- **WHEN** a document is `ai-propagated`
- **THEN** its row shows no status label

### Requirement: The library filters by area
The library SHALL offer one chip per area with its document count. Choosing an area SHALL list only documents of that area's types and show the area's types as sub-chips. The choice SHALL be kept in the URL (`?family=`).

#### Scenario: choose an area
- **WHEN** the user chooses "Mobilität"
- **THEN** the URL carries `family=mobil`, the API is asked for `document_type=Kfz&document_type=Bußgeldbescheid`, and chips for Kfz and Bußgeldbescheid appear

### Requirement: The library API filters by several types
`GET /api/library/` SHALL accept `document_type` more than once and return documents of any of the named types. Unknown names SHALL be ignored, and when none of the names is known the result SHALL be empty.

#### Scenario: two types
- **WHEN** the API is called with `document_type=Kfz&document_type=Bußgeldbescheid`
- **THEN** Paperless is queried with `document_type__id__in` holding both ids
