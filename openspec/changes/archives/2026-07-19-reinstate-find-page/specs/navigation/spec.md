## MODIFIED Requirements

### Requirement: Primary navigation includes Find
The Nav component SHALL include a Find entry (MagnifyingGlass icon, tooltip "Dokumente finden") positioned between Ask AI and Library in the desktop icon row and the mobile drawer.

#### Scenario: Desktop nav shows Find icon
- **WHEN** the user views any authenticated page on a desktop viewport
- **THEN** a MagnifyingGlass icon button with tooltip "Dokumente finden" is visible in the nav, active-highlighted when the current route is `/find`

#### Scenario: Mobile drawer shows Find entry
- **WHEN** the user opens the hamburger drawer on a mobile viewport
- **THEN** a "Dokumente finden" labelled entry with MagnifyingGlass icon prefix is present between Ask AI and Library
