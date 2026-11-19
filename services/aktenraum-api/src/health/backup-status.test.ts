import { describe, expect, it } from "vitest";

import { evaluateBackupStatus, type BackupStatusFile } from "./backup-status.js";

const NOW = new Date("2026-11-19T12:00:00Z");

function file(overrides: Partial<BackupStatusFile> = {}): BackupStatusFile {
  return {
    checked_at: "2026-11-19T11:30:00Z",
    healthy: true,
    message: "backups fresh: filesystem=2h postgres=2h postgres-aktenraum=2h",
    latest_snapshot_at: "2026-11-19T10:00:00Z",
    max_age_hours: 36,
    last_run_at: "2026-11-19T10:00:05Z",
    last_run_exit: 0,
    ...overrides,
  };
}

describe("evaluateBackupStatus", () => {
  it("is unknown without a status file", () => {
    const status = evaluateBackupStatus(null, NOW);
    expect(status.state).toBe("unknown");
    expect(status.last_backup_at).toBeNull();
  });

  it("is ok when the newest complete backup is fresh", () => {
    const status = evaluateBackupStatus(file(), NOW);
    expect(status.state).toBe("ok");
    expect(status.age_hours).toBe(2);
    expect(status.last_backup_at).toBe("2026-11-19T10:00:00Z");
  });

  it("is stale once the newest complete backup passes max_age_hours", () => {
    const status = evaluateBackupStatus(
      file({
        healthy: false,
        latest_snapshot_at: "2026-10-16T08:14:10Z",
        message: "latest filesystem snapshot is 817h old (limit 36h)",
      }),
      NOW,
    );
    expect(status.state).toBe("stale");
    expect(status.age_hours).toBeGreaterThan(36);
    expect(status.detail).toContain("817h");
  });

  it("is failing when the last run exited non-zero, even with a fresh older backup", () => {
    const status = evaluateBackupStatus(file({ last_run_exit: 3 }), NOW);
    expect(status.state).toBe("failing");
    expect(status.detail).toContain("3");
  });

  it("is failing when no snapshot could be read", () => {
    const status = evaluateBackupStatus(
      file({ healthy: false, latest_snapshot_at: null, message: "cannot open restic repository: wrong password" }),
      NOW,
    );
    expect(status.state).toBe("failing");
    expect(status.detail).toContain("wrong password");
  });

  it("is failing when the backup container stopped reporting", () => {
    const status = evaluateBackupStatus(file({ checked_at: "2026-11-19T06:00:00Z" }), NOW);
    expect(status.state).toBe("failing");
    expect(status.detail).toContain("6h");
  });

  it("treats a missing last run as no failure", () => {
    const status = evaluateBackupStatus(file({ last_run_at: null, last_run_exit: null }), NOW);
    expect(status.state).toBe("ok");
  });
});
