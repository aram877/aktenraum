export interface AutoApproveRule {
  document_type: string;
  enabled: boolean;
  min_confidence: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface DraftEntry {
  enabled: boolean;
  min_confidence: number;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function buildDraft(rules: readonly AutoApproveRule[]): Map<string, DraftEntry> {
  const draft = new Map<string, DraftEntry>();
  for (const rule of rules) {
    draft.set(rule.document_type, {
      enabled: rule.enabled,
      min_confidence: rule.min_confidence,
    });
  }
  return draft;
}

export function isDraftDirty(
  rules: readonly AutoApproveRule[],
  draft: Map<string, DraftEntry>,
): boolean {
  for (const rule of rules) {
    const entry = draft.get(rule.document_type);
    if (!entry) return true;
    if (entry.enabled !== rule.enabled) return true;
    if (entry.min_confidence !== rule.min_confidence) return true;
  }
  return false;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function mapChangePasswordError(status: number | null): string {
  if (status === 401) return "Aktuelles Passwort ist nicht korrekt.";
  if (status === 400) return "Das neue Passwort muss sich vom aktuellen unterscheiden.";
  if (status === 422) {
    return "Bitte fülle alle Felder korrekt aus (min. 8 Zeichen für das neue Passwort).";
  }
  return "Unbekannter Fehler beim Ändern des Passworts.";
}
