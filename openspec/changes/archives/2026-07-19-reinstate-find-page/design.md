## Context

The `/find` page was deleted in commit `62b02e8`. All the code still exists in git history and the backend `POST /api/ai/find` endpoint is untouched. This is a straight restore with minor updates to match the current Nav icon pattern.

## Goals / Non-Goals

**Goals:**
- Restore Find as a distinct, accessible page in the SPA
- Reuse the existing backend without any changes
- Match the current Nav icon+tooltip style (36px icon buttons) added in 62b02e8

**Non-Goals:**
- Changing the backend search logic
- Adding tag-based RAG filtering (separate concern)
- Modifying Ask AI

## Decisions

**Restore from git, don't rewrite.** The deleted Find.tsx and FilterChips.tsx are functionally correct and were only removed for navigation reasons, not quality reasons. Restoring them is lower risk than reimplementing from scratch.

**Nav placement: between Ask AI (Sparkles) and Library (Books).** Find is closer to Ask than Library in intent — both are AI-assisted. The icon will be MagnifyingGlass from the existing Icons.tsx set (or added if absent).

**Route: `/find` (same as before).** No reason to change it; no existing links to break (the old redirect was removed in the same commit).

**`SearchFilter` and `DocumentSummary` already exist in `ai.ts`** — only the mutation hook and fetch functions need to be added back.

## Risks / Trade-offs

- [Nav crowding] Adding a 4th icon to the primary group — already has Ask, Library, Upload. Mitigation: Find slots between Ask and Library naturally; the icon row is still under the 5-icon threshold where tooltips make it legible.
- [Stale code] FilterChips and Find.tsx haven't been maintained since June 1. Mitigation: The backend API shape hasn't changed (`SearchFilter`, `FindResponse` are identical), so the code is safe to restore as-is.
