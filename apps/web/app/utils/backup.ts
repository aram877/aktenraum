// Mirrors services/aktenraum-api/src/health/backup-status.ts (BackupStatus).
export type BackupState = "ok" | "stale" | "failing" | "unknown";

export interface BackupStatus {
  state: BackupState;
  last_backup_at: string | null;
  age_hours: number | null;
  max_age_hours: number | null;
  checked_at: string | null;
  last_run_at: string | null;
  last_run_exit: number | null;
  detail: string | null;
}

export interface BackupNotice {
  tone: "ok" | "warn" | "error" | "neutral";
  /** Short label for the nav pill; null when the nav should stay quiet. */
  pill: string | null;
  /** One sentence for the settings section. */
  summary: string;
}

/** "vor 3 Stunden" / "vor 34 Tagen" — coarse on purpose, it's a health hint. */
export function formatAge(hours: number | null): string {
  if (hours === null) return "unbekannt";
  if (hours < 1) return "vor weniger als einer Stunde";
  if (hours < 48) return hours === 1 ? "vor 1 Stunde" : `vor ${hours} Stunden`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tagen`;
}

export function formatBackupTime(iso: string | null): string {
  if (!iso) return "–";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "–";
  return parsed.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function backupNotice(status: BackupStatus | null | undefined): BackupNotice {
  if (!status || status.state === "unknown") {
    return {
      tone: "neutral",
      pill: null,
      summary: "Kein Backup-Status verfügbar — läuft der Backup-Dienst?",
    };
  }
  const age = formatAge(status.age_hours);
  switch (status.state) {
    case "ok":
      return { tone: "ok", pill: null, summary: `Letztes vollständiges Backup ${age}.` };
    case "stale":
      return {
        tone: "warn",
        pill: "Backup veraltet",
        summary: `Letztes vollständiges Backup ${age} — älter als ${status.max_age_hours ?? 36} Stunden.`,
      };
    case "failing":
      return {
        tone: "error",
        pill: "Backup-Fehler",
        summary:
          status.last_backup_at === null
            ? "Backup nicht lesbar — es konnte kein vollständiges Backup gefunden werden."
            : `Backup fehlgeschlagen. Letztes vollständiges Backup ${age}.`,
      };
  }
}
