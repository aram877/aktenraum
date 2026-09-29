export type UploadPhase =
  | "ready"
  | "uploading"
  | "consuming"
  | "classifying"
  | "inbox"
  | "library"
  | "error";

export const PHASE_LABEL: Record<UploadPhase, string> = {
  ready: "Bereit",
  uploading: "Wird hochgeladen…",
  consuming: "Paperless verarbeitet…",
  classifying: "KI klassifiziert…",
  inbox: "✓ in der Inbox",
  library: "✓ in der Bibliothek",
  error: "✗ Fehler",
};

export function phaseFromTags(tags: readonly string[]): UploadPhase | null {
  const set = new Set(tags);
  if (set.has("ai-error") || set.has("ai-propagation-error")) return "error";
  if (set.has("ai-pending")) return "inbox";
  if (set.has("ai-propagated") || set.has("ai-approved") || set.has("ai-rejected")) {
    return "library";
  }
  return null;
}
