import { afterEach, describe, expect, it } from "vitest";

import { documentSpaces, households, members, spaceMembers, spaces, users } from "../db/schema.js";
import type { BackupStatusFile } from "../health/backup-status.js";
import { FakeGateway, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import {
  evaluateBackupGate,
  formatSummary,
  TenancyMigration,
  type MigrationVectorStore,
} from "./migrate.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Qdrant stand-in: chunks per document and the space they carry. */
class FakeChunks implements MigrationVectorStore {
  readonly chunks = new Map<number, { count: number; spaceId: number | null }>();
  readonly writes: number[] = [];

  async countChunksOutsideSpace(docId: number, spaceId: number): Promise<number> {
    const entry = this.chunks.get(docId);
    return entry === undefined || entry.spaceId === spaceId ? 0 : entry.count;
  }

  async setSpaceByDocId(docId: number, space: { spaceId: number | null }): Promise<void> {
    const entry = this.chunks.get(docId);
    if (entry !== undefined) entry.spaceId = space.spaceId;
    this.writes.push(docId);
  }
}

/**
 * The live install in miniature: users table only (pre-tenancy), a superuser
 * owning most documents, some ownerless, owned vocabulary, indexed chunks.
 */
async function preTenancyInstall() {
  harness = await createHarness(); // no bootstrap user → startup reconcile creates only the household
  await harness.db.delete(households);
  await harness.db.insert(users).values({ username: "aram", passwordHash: "x" });
  const docs = [1, 2, 3, 4, 5].map((id) => makeDoc({ id }));
  const paperless = new FakeGateway({ docs });
  for (const id of [4, 5]) {
    paperless.permissions.set(id, { owner: null, permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } } });
  }
  const chunks = new FakeChunks();
  for (const id of [1, 2, 3]) chunks.chunks.set(id, { count: 4, spaceId: null });
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const migration = (dryRun: boolean) =>
    new TenancyMigration({
      db: harness!.db,
      paperless,
      vectorStore: chunks,
      dryRun,
      emit: (event, fields) => events.push({ event, fields }),
    });
  return { h: harness, paperless, chunks, events, migration };
}

async function tableCounts(h: Harness) {
  return {
    households: (await h.db.select().from(households)).length,
    members: (await h.db.select().from(members)).length,
    spaces: (await h.db.select().from(spaces)).length,
    spaceMembers: (await h.db.select().from(spaceMembers)).length,
    documentSpaces: (await h.db.select().from(documentSpaces)).length,
  };
}

describe("tenancy migration", () => {
  it("dry run writes nothing and reports the full plan", async () => {
    const { h, paperless, chunks, migration } = await preTenancyInstall();
    const vocabularyBefore = structuredClone(paperless.vocabulary);

    const result = await migration(true).run();

    expect(await tableCounts(h)).toEqual({ households: 0, members: 0, spaces: 0, spaceMembers: 0, documentSpaces: 0 });
    expect(paperless.tenancyWrites).toEqual([]);
    expect(paperless.passwords.size).toBe(0);
    expect(paperless.vocabulary).toEqual(vocabularyBefore);
    expect(chunks.writes).toEqual([]);

    const changes = Object.fromEntries(result.steps.map((s) => [s.step, s.changes]));
    expect(changes[1]).toEqual({ households_created: 1, members_created: 1, personal_spaces_created: 1, space_owners_repaired: 0 });
    expect(changes[2]).toMatchObject({ users_created: 1, groups_created: 1 });
    expect(changes[3]).toEqual({
      tags_owner_cleared: paperless.vocabulary["/api/tags/"].length,
      correspondents_owner_cleared: paperless.vocabulary["/api/correspondents/"].length,
      document_types_owner_cleared: paperless.vocabulary["/api/document_types/"].length,
    });
    expect(changes[4]).toEqual({ documents_assigned: 5 });
    expect(changes[5]).toEqual({ documents_updated: 5 });
    expect(result.verification?.ok).toBe(false);
  });

  it("real run migrates everything and verifies through the member's own Paperless user", async () => {
    const { h, paperless, chunks, migration } = await preTenancyInstall();

    const result = await migration(false).run();

    expect(result.verification).toMatchObject({
      ok: true,
      documents: 5,
      withoutHomeSpace: [],
      permissionDrift: [],
      ownedVocabulary: 0,
    });
    const [member] = await h.db.select().from(members);
    const [space] = await h.db.select().from(spaces);
    expect(member).toMatchObject({ role: "admin" });
    expect(result.verification?.memberChecks).toEqual([
      { memberId: member!.id, username: `ak-${member!.id}`, expected: 5, visible: 5 },
    ]);
    // Ownerless documents became owned, like the rest.
    expect(paperless.permissions.get(4)?.owner).toBe(member!.paperlessUserId);
    expect(paperless.visibleTo(member!.paperlessUserId!)).toEqual([1, 2, 3, 4, 5]);
    expect([...chunks.chunks.values()].every((c) => c.spaceId === space!.id)).toBe(true);
    // The verification password was rotated away again.
    expect(paperless.passwords.size).toBe(1);
  });

  it("re-running a migrated install has nothing to do", async () => {
    const { paperless, chunks, migration } = await preTenancyInstall();
    await migration(false).run();
    const writes = paperless.tenancyWrites.length;
    const chunkWrites = chunks.writes.length;

    const again = await migration(false).run();

    for (const step of again.steps) {
      expect({ step: step.step, changes: step.changes }).toEqual({
        step: step.step,
        changes: Object.fromEntries(Object.keys(step.changes).map((k) => [k, 0])),
      });
    }
    expect(again.verification?.ok).toBe(true);
    expect(paperless.tenancyWrites).toHaveLength(writes);
    expect(chunks.writes).toHaveLength(chunkWrites);
    expect(formatSummary(again, { allowed: true, detail: "x" })).toContain("1. household, members, personal spaces: nothing to do");
  });

  it("reports drift and repairs it on the next run", async () => {
    const { paperless, migration } = await preTenancyInstall();
    await migration(false).run();
    // Someone changed document 3 in Paperless's own UI.
    paperless.permissions.set(3, { owner: 3, permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } } });

    const check = await migration(true).run();
    expect(check.verification).toMatchObject({ ok: false, permissionDrift: [3] });
    expect(check.steps.find((s) => s.step === 5)?.changes).toEqual({ documents_updated: 1 });

    const repaired = await migration(false).run();
    expect(repaired.verification).toMatchObject({ ok: true, permissionDrift: [] });
  });

  it("assigns documents that arrived after a first run", async () => {
    const { paperless, migration } = await preTenancyInstall();
    await migration(false).run();
    paperless.docs.set(6, makeDoc({ id: 6 }));

    const again = await migration(false).run();
    expect(again.steps.find((s) => s.step === 4)?.changes).toEqual({ documents_assigned: 1 });
    expect(again.verification?.ok).toBe(true);
  });

  it("falls back to per-document writes when bulk_edit is rejected", async () => {
    const { paperless, events, migration } = await preTenancyInstall();
    paperless.bulkSetDocumentPermissions = async () => {
      throw new Error("bulk_edit set_permissions: owner not accepted");
    };

    const result = await migration(false).run();

    expect(result.verification?.ok).toBe(true);
    expect(result.steps.find((s) => s.step === 5)?.details).toEqual({ bulk_fallbacks: 1 });
    expect(events.some((e) => e.event === "tenancy_migrate_bulk_fallback")).toBe(true);
    expect(paperless.tenancyWrites.filter((w) => w.op === "setDocumentPermissions")).toHaveLength(5);
  });

  it("skips the Qdrant step cleanly without a vector store", async () => {
    const { h, paperless } = await preTenancyInstall();
    const result = await new TenancyMigration({ db: h.db, paperless, vectorStore: null, dryRun: false, emit: () => undefined }).run();
    expect(result.steps.find((s) => s.step === 6)).toMatchObject({ changes: { documents_updated: 0 }, details: { skipped: "QDRANT_URL not set" } });
    expect(result.verification?.ok).toBe(true);
  });
});

describe("backup gate", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  const status = (overrides: Partial<BackupStatusFile> = {}): BackupStatusFile => ({
    checked_at: "2026-11-19T11:50:00Z",
    healthy: true,
    message: "backups fresh",
    latest_snapshot_at: "2026-11-19T11:30:00Z",
    max_age_hours: 36,
    ...overrides,
  });

  it("allows a healthy backup younger than 2 h", () => {
    expect(evaluateBackupGate(status(), now, false)).toMatchObject({ allowed: true });
  });

  it("refuses a 30 h old backup and says why", () => {
    const decision = evaluateBackupGate(status({ latest_snapshot_at: "2026-11-18T06:00:00Z" }), now, false);
    expect(decision).toEqual({
      allowed: false,
      reason: "newest complete backup is 30.0 h old (limit 2 h) — run a manual snapshot first",
    });
  });

  it("refuses an unhealthy backup, a missing file and a missing snapshot", () => {
    expect(evaluateBackupGate(status({ healthy: false, message: "repo locked" }), now, false)).toMatchObject({
      allowed: false,
      reason: "backup is not healthy: repo locked",
    });
    expect(evaluateBackupGate(null, now, false)).toMatchObject({ allowed: false });
    expect(evaluateBackupGate(status({ latest_snapshot_at: null }), now, false)).toMatchObject({ allowed: false });
  });

  it("can be overridden explicitly", () => {
    expect(evaluateBackupGate(null, now, true)).toEqual({ allowed: true, detail: "--i-have-a-backup given" });
  });
});
