# Proposal

## Why

The maintainer asked for a dark mode on 2026-11-22, right after the editorial redesign (`ui-redesign-foundation`) went live. Evening use of a document archive on a bright warm-paper page is tiring, and most devices already run a system-wide dark setting.

## What Changes

- **Dark theme**: a dark value for every colour token (warm near-black paper, `#171412` canvas, `#211d1a` surface, `#ede6da` ink, a lighter sealing-wax accent), applied by a `dark` class on `<html>`.
- **Switching**: follows the device setting by default. A toggle in the navigation cycles **System → Hell → Dunkel**. The choice is stored per device (`localStorage`), and in System mode the app follows a change of the OS setting live. `color-scheme` is set so native controls (date pickers, scrollbars) match.
- **Document type colours**: the 9 area colours become CSS variables generated from `utils/doc-types.ts` (the single source), each with a dark tint and ink. Tile fills stay the same in both themes.
- **Status colours**: danger / warning / info become tokens (`tone-*`) with dark values. The Tailwind red / amber / emerald / sky shades that the app uses for alerts are remapped in dark mode globally, so existing alert boxes keep working without per-file `dark:` classes.
- Tests: contrast checked for both themes (area ink on tint, status tones and `ink-subtle` on surface); unit tests for the preference logic; a component test for the toggle.

## Non-goals

- A per-account theme stored on the server (per device is enough for now).
- Restyling the PDF preview itself (Paperless renders it).
