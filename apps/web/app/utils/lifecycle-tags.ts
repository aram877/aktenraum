export const LIFECYCLE_TAG_NAMES: ReadonlySet<string> = new Set([
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

export function userFacingTags(names: readonly string[]): string[] {
  return names.filter((n) => !LIFECYCLE_TAG_NAMES.has(n));
}
