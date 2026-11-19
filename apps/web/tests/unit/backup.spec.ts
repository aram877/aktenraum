import { describe, expect, it } from "vitest";

import { backupNotice, formatAge, type BackupStatus } from "~/utils/backup";

function status(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    state: "ok",
    last_backup_at: "2026-11-19T10:31:49Z",
    age_hours: 2,
    max_age_hours: 36,
    checked_at: "2026-11-19T12:00:00Z",
    last_run_at: "2026-11-19T10:31:50Z",
    last_run_exit: 0,
    detail: null,
    ...overrides,
  };
}

describe("formatAge", () => {
  it("is coarse: hours under two days, then days", () => {
    expect(formatAge(null)).toBe("unbekannt");
    expect(formatAge(0)).toBe("vor weniger als einer Stunde");
    expect(formatAge(1)).toBe("vor 1 Stunde");
    expect(formatAge(30)).toBe("vor 30 Stunden");
    expect(formatAge(817)).toBe("vor 34 Tagen");
  });
});

describe("backupNotice", () => {
  it("keeps the nav quiet when backups are fine", () => {
    const notice = backupNotice(status());
    expect(notice.pill).toBeNull();
    expect(notice.tone).toBe("ok");
    expect(notice.summary).toContain("vor 2 Stunden");
  });

  it("keeps the nav quiet when no status is available (dev/e2e)", () => {
    expect(backupNotice(null).pill).toBeNull();
    expect(backupNotice(status({ state: "unknown" })).pill).toBeNull();
  });

  it("warns when backups are stale", () => {
    const notice = backupNotice(status({ state: "stale", age_hours: 817 }));
    expect(notice.pill).toBe("Backup veraltet");
    expect(notice.tone).toBe("warn");
    expect(notice.summary).toContain("vor 34 Tagen");
  });

  it("errors when the backup is failing", () => {
    const notice = backupNotice(status({ state: "failing", last_run_exit: 3 }));
    expect(notice.pill).toBe("Backup-Fehler");
    expect(notice.tone).toBe("error");
  });

  it("explains an unreadable repository", () => {
    const notice = backupNotice(status({ state: "failing", last_backup_at: null, age_hours: null }));
    expect(notice.summary).toContain("nicht lesbar");
  });
});
