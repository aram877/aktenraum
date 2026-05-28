/**
 * Names the auto-tagger uses to mark a document's pipeline state in
 * Paperless's `tags` collection. We hide them from the user-facing tag
 * footers and from the suggested-tags fallback so the review form only
 * shows topical tags ("AOK NordWest", "Versicherung") — not internal
 * state like ai-propagated / ai-low-confidence.
 *
 * Keep in sync with the Python-side LIFECYCLE_TAGS in
 * packages/aktenraum-core/src/aktenraum_core/paperless/client.py, plus
 * the auxiliary names (ai-auto-approved / ai-low-confidence /
 * ai-index-error / ai-duplicate / ai-duplicate-dismissed) that aren't in
 * LIFECYCLE_TAGS but are equally internal-only. The duplicate signal is
 * surfaced via its own purple badge + "Mögliches Duplikat" links, never as
 * a raw topical tag.
 */
export const LIFECYCLE_TAG_NAMES = new Set<string>([
  "ai-pending",
  "ai-approved",
  "ai-rejected",
  "ai-propagated",
  "ai-propagation-error",
  "ai-error",
  "ai-auto-approved",
  "ai-low-confidence",
  "ai-index-error",
  "ai-duplicate",
  "ai-duplicate-dismissed",
]);

/** Filter a list of tag names down to the user-facing topical subset. */
export function userFacingTags(names: readonly string[]): string[] {
  return names.filter((n) => !LIFECYCLE_TAG_NAMES.has(n));
}
