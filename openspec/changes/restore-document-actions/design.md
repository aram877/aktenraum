## Decisions

**Second pass uses `complete`, not `streamText`.** The Python pass streamed free text and parsed JSON by hand. `complete` with a zod schema built from `TYPE_FIELD_SCHEMA` gets Ollama's JSON mode, the repair/retry loop, the new timeout, and Anthropic tool-use for free. Values are coerced to strings; the API normalises money/date/month/year.

**Non-fatal and after routing.** Lifecycle tags are already written when the pass runs, so a failure only logs `type_specific_pass_failed`; the document still reaches review. Transient-retry does not apply here.

**`null` clears, worker never sends `null`.** The UI needs to clear a field; the worker must not wipe a value the user typed because the model missed it on a reprocess. So the worker drops empty values and only the UI sends `null`.

**Duplicate candidates only for flagged docs.** The panel (and its query) renders only when `ai-duplicate` is on the document; dismissing invalidates the detail so the panel disappears.

**Delete reuses the two-click confirm** used by "Erneut verarbeiten" rather than a modal — consistent and keyboard-friendly; the document stays restorable in `/trash`.
