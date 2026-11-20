# Proposal

## Why

ADR-009 part 2, last of three changes (`tenancy-members` → `tenancy-shared-spaces` → `tenancy-document-shares`). Shared spaces cover what a household manages together long-term. They don't cover the exceptions: lending the car-loan contract to a partner, or giving someone three payslips for a rental application, without moving those documents out of a personal space. ADR-009's rule of thumb: "something managed together long-term goes into a shared space; an exception goes into a share."

## What Changes

- **Per-document shares**: the owner of a document's home space can share it with another household member as `viewer` (see, download, ask the AI about it) or `editor` (also correct its AI fields and type fields). Optional expiry date. Shares are explicit, one document and one member at a time, never rule-based (ADR-009).
- **What a share does not allow**: deleting, moving, re-sharing, approving, rejecting, reprocessing or starring. Those stay with the home space. A shared document also never enters the recipient's review inbox.
- **Revoke and expiry**: the owner revokes any share at any time, and expiry is checked on every request. Both take effect at once for lists, document access, Paperless and Ask. A periodic sweep removes expired shares from Paperless permissions and the Qdrant payload.
- **Paperless enforces it too**: a viewer share adds the recipient's Paperless user to the document's `view.users`, an editor share to `view.users` and `change.users`. Documents without shares keep exactly today's permissions.
- **Ask follows shares**: the Qdrant payload `shared_with` (already indexed and filtered on since `tenancy-foundation`) gets the recipients. Few-shot examples, the history hint and duplicate detection stay scoped to the home space, so a shared document never feeds the recipient's own extraction prompts.
- **Audit log**: every grant, role change, revoke and expiry, and every access by a recipient (detail, preview, download, Ask citation; at most one entry per share and kind per hour), is recorded. The document's home-space owner can read it.
- **SPA**:
  - "Teilen" on the library detail page: share with a member, pick the role, set an optional expiry, list current shares, revoke.
  - A new page "Geteilt" with two tabs. "Mit mir geteilt" lists what others shared with me, labelled with who shared it and when it expires. "Von mir geteilt" lists everything I shared, with revoke and each share's audit entries.
  - Library rows and detail headers of shared documents show "Geteilt von <name>" instead of a space.
  - Hidden while the household has one member, like every other space feature.

## Non-goals

- Shares with people outside the household, public links.
- Rule-based or automatic sharing ("share every Gehaltsabrechnung").
- Sharing a whole space through this mechanism (that is space membership).
- Member removal from the household (still deferred; it will have to revoke that member's shares).
- An audit log for anything other than shares (logins, space changes: ADR-010).
- End-to-end encryption semantics of revocation (cloud phase).

## Capabilities

### New Capabilities
- `document-shares`: granting, changing and revoking a per-document share, its roles and expiry, what a recipient may and may not do, how Paperless and Ask enforce it, and the share audit log.

### Modified Capabilities
<!-- none: main specs are not kept in this repo; requirements are written as ADDED -->

## Impact

- **API**:
  - New `shares/` module: grant, change role, revoke, list per document, "with me", "by me", and the audit log.
  - New tables `document_shares` and `share_audit`.
  - `PolicyService` grants access through an active share.
  - New `DocumentAction` `edit-fields`, held by space editors/owners and share editors. The AI-field and type-field routes move to it from `write`.
  - `paperless-mirror.ts` adds share users to a document's target permissions.
  - `GET /api/tenancy/documents/:doc_id/space` returns the real `shared_with`.
  - Library rows and detail payloads carry `shared_by` for the recipient.
  - An expiry sweep runs in the api.
- **Worker**: none. It already reads `shared_with` from the api when it writes chunks.
- **Web**: "Teilen" panel on `/library/[id]`, `/geteilt` page with nav entry, "Geteilt von" badge, `useShares` composable.
- **Live data**: no migration. No document has a share, so the mirror reports `unchanged` everywhere. The new tables are created by `applySchema`.
- **Docs**: ADR-009 "as built" note, CLAUDE.md, api-reference, session note.
