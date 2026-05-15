# TODOS

- Add checkboxes to the archive tab rows (same pattern as the Zur Prüfung tab already has)
- A sticky action bar appears when ≥1 doc selected: shows count + "Erneut verarbeiten" button (and a "Alle auswählen"
  checkbox in the header)
- A useBulkReprocess hook that fires parallel POST /api/documents/{id}/reprocess calls, same pattern as useBulkApprove
- After completion, a brief result summary ("N neu angestoßen · M fehlgeschlagen") before clearing selection

No backend changes needed — the existing /reprocess endpoint is fire-and-forget so parallel calls are fine.
