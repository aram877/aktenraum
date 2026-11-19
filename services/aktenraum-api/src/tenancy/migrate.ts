import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { logger, QdrantVectorStore } from "@aktenraum/core";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { loadSettings } from "../config/settings.js";
import { toNodePostgresUrl, type Database } from "../db/db.module.js";
import * as schema from "../db/schema.js";
import { documentSpaces, members, spaces } from "../db/schema.js";
import { backupStatusFileSchema, type BackupStatusFile } from "../health/backup-status.js";
import {
  PaperlessGateway,
  type DocumentPermissions,
  type SharedVocabularyEndpoint,
} from "../paperless/paperless.gateway.js";
import {
  memberUsername,
  provisionMemberUser,
  provisionSpaceGroup,
  samePermissions,
  spaceDocumentPermissions,
  type PaperlessTenancyPort,
} from "./paperless-mirror.js";
import { reconcileTenancy } from "./reconcile.js";

/**
 * One-off tenancy migration (tenancy-foundation §6, ADR-009 §Migration).
 *
 * Seven ordered steps, each idempotent and logged, so a crash resumes by
 * running it again: (1) household/member/personal space, (2) Paperless users
 * and groups, (3) shared vocabulary (`owner = null`), (4) a home space for
 * every document, (5) Paperless owner + permissions per document, (6) Qdrant
 * `space_id` backfill, (7) verification. `--dry-run` writes nothing.
 *
 *   node dist/tenancy/migrate.js [--dry-run] [--i-have-a-backup]
 */

export const BACKUP_MAX_AGE_HOURS = 2;
const BULK_CHUNK = 100;
const VOCABULARY: readonly SharedVocabularyEndpoint[] = [
  "/api/tags/",
  "/api/correspondents/",
  "/api/document_types/",
];

/** The Paperless calls the migration makes, on top of the mirror's. */
export type MigrationPaperless = PaperlessTenancyPort &
  Pick<
    PaperlessGateway,
    | "listOwnedEntities"
    | "clearOwner"
    | "listDocumentPermissions"
    | "setUserPassword"
    | "countDocumentsVisibleTo"
  >;

export type MigrationVectorStore = Pick<QdrantVectorStore, "countChunksOutsideSpace" | "setSpaceByDocId">;

export interface StepReport {
  step: number;
  name: string;
  /** What changed (or, in a dry run, would change). All zero = nothing to do. */
  changes: Record<string, number>;
  details?: Record<string, unknown>;
}

export interface VerificationReport {
  ok: boolean;
  documents: number;
  withoutHomeSpace: number[];
  permissionDrift: number[];
  ownedVocabulary: number;
  memberChecks: { memberId: number; username: string; expected: number; visible: number | null }[];
}

export interface MigrationResult {
  dryRun: boolean;
  steps: StepReport[];
  verification: VerificationReport | null;
}

export interface MigrationDeps {
  db: Database;
  paperless: MigrationPaperless;
  vectorStore: MigrationVectorStore | null;
  dryRun: boolean;
  /** Per-step / progress events; defaults to the structured logger. */
  emit?: (event: string, fields: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Backup gate
// ---------------------------------------------------------------------------

export type GateDecision = { allowed: true; detail: string } | { allowed: false; reason: string };

/**
 * The real run needs a complete backup younger than 2 h: the status file the
 * backup healthcheck writes must say healthy, and its `latest_snapshot_at`
 * (the OLDEST of the newest filesystem / postgres / postgres-aktenraum
 * snapshots) must be recent. Paperless permission changes can only be undone
 * from that snapshot.
 */
export function evaluateBackupGate(
  file: BackupStatusFile | null,
  now: Date,
  override: boolean,
): GateDecision {
  if (override) return { allowed: true, detail: "--i-have-a-backup given" };
  if (file === null) {
    return { allowed: false, reason: "no backup status file — is the backup service running?" };
  }
  if (!file.healthy) return { allowed: false, reason: `backup is not healthy: ${file.message}` };
  const taken = file.latest_snapshot_at === null ? NaN : Date.parse(file.latest_snapshot_at);
  if (Number.isNaN(taken)) return { allowed: false, reason: "no complete backup snapshot recorded" };
  const ageHours = (now.getTime() - taken) / 3_600_000;
  if (ageHours > BACKUP_MAX_AGE_HOURS) {
    return {
      allowed: false,
      reason: `newest complete backup is ${ageHours.toFixed(1)} h old (limit ${BACKUP_MAX_AGE_HOURS} h) — run a manual snapshot first`,
    };
  }
  return { allowed: true, detail: `newest complete backup is ${ageHours.toFixed(1)} h old` };
}

export async function readBackupStatus(path: string): Promise<BackupStatusFile | null> {
  try {
    const parsed = backupStatusFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function adminPersonalSpace(db: Database): Promise<number | null> {
  const rows = await db
    .select({ spaceId: spaces.id })
    .from(members)
    .innerJoin(spaces, eq(spaces.personalMemberId, members.id))
    .where(eq(members.role, "admin"))
    .orderBy(asc(members.id))
    .limit(1);
  return rows[0]?.spaceId ?? null;
}

export class TenancyMigration {
  private readonly emit: (event: string, fields: Record<string, unknown>) => void;
  /** Paperless state read once in step 4 and reused by 5 and 7. */
  private paperlessPermissions: Map<number, DocumentPermissions> | null = null;

  constructor(private readonly deps: MigrationDeps) {
    this.emit = deps.emit ?? ((event, fields) => logger.info(event, fields));
  }

  async run(): Promise<MigrationResult> {
    const steps: StepReport[] = [];
    const record = (report: StepReport): void => {
      steps.push(report);
      this.emit("tenancy_migrate_step", { dry_run: this.deps.dryRun, ...report });
    };
    record(await this.step1Reconcile());
    record(await this.step2Paperless());
    record(await this.step3Vocabulary());
    record(await this.step4HomeSpaces());
    record(await this.step5Permissions());
    record(await this.step6Qdrant());
    const verification = await this.step7Verify();
    this.emit("tenancy_migrate_verified", { dry_run: this.deps.dryRun, ...verification });
    return { dryRun: this.deps.dryRun, steps, verification };
  }

  async step1Reconcile(): Promise<StepReport> {
    const report = await reconcileTenancy(this.deps.db, { dryRun: this.deps.dryRun });
    return {
      step: 1,
      name: "household, members, personal spaces",
      changes: {
        households_created: report.householdCreated ? 1 : 0,
        members_created: report.membersCreated,
        personal_spaces_created: report.personalSpacesCreated,
        space_owners_repaired: report.spaceOwnersRepaired,
      },
    };
  }

  async step2Paperless(): Promise<StepReport> {
    const { db, paperless, dryRun } = this.deps;
    const changes = { users_created: 0, users_linked: 0, groups_created: 0, groups_linked: 0, group_members_added: 0 };
    const allMembers = await db.select({ id: members.id, paperlessUserId: members.paperlessUserId }).from(members);
    const allSpaces = await db.select({ id: spaces.id, paperlessGroupId: spaces.paperlessGroupId }).from(spaces);

    if (dryRun) {
      for (const m of allMembers) {
        if (m.paperlessUserId !== null) continue;
        if ((await paperless.findUserByUsername(memberUsername(m.id))) !== null) changes.users_linked += 1;
        else changes.users_created += 1;
      }
      for (const s of allSpaces) {
        if (s.paperlessGroupId === null) changes.groups_created += 1;
      }
      // Members/spaces step 1 would create don't exist yet: one user + group each.
      const users = await db.select({ id: schema.users.id }).from(schema.users);
      const pending = Math.max(0, users.length - allMembers.length);
      changes.users_created += pending;
      changes.groups_created += pending;
      return { step: 2, name: "Paperless users and groups", changes };
    }

    for (const m of allMembers) {
      const { outcome } = await provisionMemberUser(db, paperless, m.id);
      if (outcome === "created") changes.users_created += 1;
      if (outcome === "linked") changes.users_linked += 1;
    }
    for (const s of allSpaces) {
      const { outcome, membersAdded } = await provisionSpaceGroup(db, paperless, s.id);
      if (outcome === "created") changes.groups_created += 1;
      if (outcome === "linked") changes.groups_linked += 1;
      changes.group_members_added += membersAdded;
    }
    return { step: 2, name: "Paperless users and groups", changes };
  }

  async step3Vocabulary(): Promise<StepReport> {
    const { paperless, dryRun } = this.deps;
    const changes: Record<string, number> = {};
    for (const endpoint of VOCABULARY) {
      const key = `${endpoint.split("/")[2]}_owner_cleared`;
      const owned = (await paperless.listOwnedEntities(endpoint)).filter((e) => e.owner !== null);
      changes[key] = owned.length;
      if (dryRun) continue;
      let done = 0;
      for (const entity of owned) {
        await paperless.clearOwner(endpoint, entity.id);
        done += 1;
        if (done % 100 === 0) this.emit("tenancy_migrate_progress", { step: 3, endpoint, done, total: owned.length });
      }
    }
    return { step: 3, name: "shared vocabulary (owner = null)", changes };
  }

  async step4HomeSpaces(): Promise<StepReport> {
    const { db, paperless, dryRun } = this.deps;
    this.paperlessPermissions = await paperless.listDocumentPermissions();
    const paperlessIds = [...this.paperlessPermissions.keys()];
    const assigned = new Set(
      (await db.select({ docId: documentSpaces.paperlessDocId }).from(documentSpaces)).map((r) => r.docId),
    );
    const missing = paperlessIds.filter((id) => !assigned.has(id));
    const orphans = [...assigned].filter((id) => !this.paperlessPermissions!.has(id));

    if (!dryRun && missing.length > 0) {
      const target = await adminPersonalSpace(db);
      if (target === null) throw new Error("no household admin with a personal space — step 1 did not run");
      for (let i = 0; i < missing.length; i += BULK_CHUNK) {
        const chunk = missing.slice(i, i + BULK_CHUNK);
        await db
          .insert(documentSpaces)
          .values(chunk.map((paperlessDocId) => ({ paperlessDocId, spaceId: target })))
          .onConflictDoNothing();
      }
    }
    return {
      step: 4,
      name: "home space for every document",
      changes: { documents_assigned: missing.length },
      details: {
        paperless_documents: paperlessIds.length,
        already_assigned: paperlessIds.length - missing.length,
        // Rows for documents Paperless no longer lists (trashed/deleted) — reported, never deleted.
        orphan_rows: orphans.length,
      },
    };
  }

  async step5Permissions(): Promise<StepReport> {
    const { db, paperless, dryRun } = this.deps;
    const current = this.paperlessPermissions ?? (await paperless.listDocumentPermissions());
    const rows = await db.select().from(documentSpaces);
    const bySpace = new Map<number, number[]>();
    for (const row of rows) {
      if (!current.has(row.paperlessDocId)) continue;
      bySpace.set(row.spaceId, [...(bySpace.get(row.spaceId) ?? []), row.paperlessDocId]);
    }
    let changed = 0;
    let bulkFallbacks = 0;
    // Dry run before step 1/2 created anything: every document will change.
    const assignedIds = new Set(rows.map((r) => r.paperlessDocId));
    const unassignedInDryRun = dryRun ? [...current.keys()].filter((id) => !assignedIds.has(id)) : [];
    changed += unassignedInDryRun.length;

    for (const [spaceId, docIds] of bySpace) {
      let target: DocumentPermissions | null = null;
      if (dryRun) {
        target = await this.peekTarget(spaceId);
      } else {
        target = await spaceDocumentPermissions(db, paperless, spaceId);
      }
      const differing = docIds.filter((id) => target === null || !samePermissions(current.get(id)!, target));
      changed += differing.length;
      if (dryRun || target === null) continue;
      for (let i = 0; i < differing.length; i += BULK_CHUNK) {
        const chunk = differing.slice(i, i + BULK_CHUNK);
        try {
          await paperless.bulkSetDocumentPermissions(chunk, target);
        } catch (error: unknown) {
          bulkFallbacks += 1;
          this.emit("tenancy_migrate_bulk_fallback", { step: 5, error: String(error), documents: chunk.length });
          for (const id of chunk) await paperless.setDocumentPermissions(id, target);
        }
        this.emit("tenancy_migrate_progress", { step: 5, done: Math.min(i + BULK_CHUNK, differing.length), total: differing.length });
      }
    }
    if (!dryRun) this.paperlessPermissions = null; // stale now; step 7 re-reads
    return {
      step: 5,
      name: "Paperless owner + permissions per document",
      changes: { documents_updated: changed },
      details: { bulk_fallbacks: bulkFallbacks },
    };
  }

  /** Target permissions without provisioning anything; null = not known yet (dry run before step 2). */
  private async peekTarget(spaceId: number): Promise<DocumentPermissions | null> {
    const { db } = this.deps;
    const space = (await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1))[0];
    if (space === undefined || space.paperlessGroupId === null) return null;
    let ownerMemberId = space.personalMemberId;
    if (ownerMemberId === null) {
      const owners = await db
        .select({ memberId: schema.spaceMembers.memberId })
        .from(schema.spaceMembers)
        .where(and(eq(schema.spaceMembers.spaceId, spaceId), eq(schema.spaceMembers.role, "owner")))
        .orderBy(asc(schema.spaceMembers.memberId))
        .limit(1);
      ownerMemberId = owners[0]?.memberId ?? null;
    }
    if (ownerMemberId === null) return null;
    const owner = (
      await db
        .select({ paperlessUserId: members.paperlessUserId })
        .from(members)
        .where(eq(members.id, ownerMemberId))
        .limit(1)
    )[0];
    if (owner === undefined || owner.paperlessUserId === null) return null;
    return {
      owner: owner.paperlessUserId,
      permissions: {
        view: { users: [], groups: [space.paperlessGroupId] },
        change: { users: [], groups: [space.paperlessGroupId] },
      },
    };
  }

  async step6Qdrant(): Promise<StepReport> {
    const { db, vectorStore, dryRun } = this.deps;
    if (vectorStore === null) {
      return { step: 6, name: "Qdrant space backfill", changes: { documents_updated: 0 }, details: { skipped: "QDRANT_URL not set" } };
    }
    const rows = await db.select().from(documentSpaces);
    let documents = 0;
    let chunks = 0;
    for (const row of rows) {
      const outside = await vectorStore.countChunksOutsideSpace(row.paperlessDocId, row.spaceId);
      if (outside === 0) continue;
      documents += 1;
      chunks += outside;
      if (!dryRun) await vectorStore.setSpaceByDocId(row.paperlessDocId, { spaceId: row.spaceId, sharedWith: [] });
    }
    return {
      step: 6,
      name: "Qdrant space backfill",
      changes: { documents_updated: documents },
      details: { chunks_updated: chunks },
    };
  }

  async step7Verify(): Promise<VerificationReport> {
    const { db, paperless, dryRun } = this.deps;
    const current = this.paperlessPermissions ?? (await paperless.listDocumentPermissions());
    const rows = await db.select().from(documentSpaces);
    const spaceByDoc = new Map(rows.map((r) => [r.paperlessDocId, r.spaceId]));
    const withoutHomeSpace = [...current.keys()].filter((id) => !spaceByDoc.has(id));

    const targets = new Map<number, DocumentPermissions | null>();
    const permissionDrift: number[] = [];
    for (const [docId, perms] of current) {
      const spaceId = spaceByDoc.get(docId);
      if (spaceId === undefined) continue;
      if (!targets.has(spaceId)) targets.set(spaceId, await this.peekTarget(spaceId));
      const target = targets.get(spaceId) ?? null;
      if (target === null || !samePermissions(perms, target)) permissionDrift.push(docId);
    }

    let ownedVocabulary = 0;
    for (const endpoint of VOCABULARY) {
      ownedVocabulary += (await paperless.listOwnedEntities(endpoint)).filter((e) => e.owner !== null).length;
    }

    // Paperless's own enforcement: log in as each member's Paperless user and
    // count. Needs a (random, discarded) password — skipped in a dry run.
    const memberChecks: VerificationReport["memberChecks"] = [];
    const allMembers = await db.select().from(members);
    for (const member of allMembers) {
      const memberSpaces = new Set(
        (await db.select({ spaceId: schema.spaceMembers.spaceId }).from(schema.spaceMembers).where(eq(schema.spaceMembers.memberId, member.id))).map((r) => r.spaceId),
      );
      const expected = rows.filter((r) => memberSpaces.has(r.spaceId) && current.has(r.paperlessDocId)).length;
      let visible: number | null = null;
      if (!dryRun && member.paperlessUserId !== null) {
        const password = randomBytes(24).toString("base64url");
        await paperless.setUserPassword(member.paperlessUserId, password);
        try {
          visible = await paperless.countDocumentsVisibleTo(memberUsername(member.id), password);
        } finally {
          await paperless.setUserPassword(member.paperlessUserId, randomBytes(32).toString("base64url"));
        }
      }
      memberChecks.push({ memberId: member.id, username: memberUsername(member.id), expected, visible });
    }

    const ok =
      withoutHomeSpace.length === 0 &&
      permissionDrift.length === 0 &&
      ownedVocabulary === 0 &&
      memberChecks.every((c) => c.visible === c.expected);
    return {
      ok,
      documents: current.size,
      withoutHomeSpace,
      permissionDrift,
      ownedVocabulary,
      memberChecks,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatSummary(result: MigrationResult, gate: GateDecision): string {
  const lines = [
    result.dryRun ? "Tenancy migration — DRY RUN (nothing written)" : "Tenancy migration",
    `Backup gate: ${gate.allowed ? `ok (${gate.detail})` : `REFUSED — ${gate.reason}`}`,
  ];
  for (const step of result.steps) {
    const changes = Object.entries(step.changes).map(([k, v]) => `${k}=${v}`).join(", ");
    const idle = Object.values(step.changes).every((v) => v === 0);
    lines.push(`  ${step.step}. ${step.name}: ${idle ? "nothing to do" : changes}`);
  }
  const v = result.verification;
  if (v !== null) {
    lines.push(
      `  7. verification: ${v.ok ? "OK" : "NOT OK"} — ${v.documents} documents, ${v.withoutHomeSpace.length} without home space, ${v.permissionDrift.length} with permission drift, ${v.ownedVocabulary} owned tags/types/correspondents`,
    );
    for (const c of v.memberChecks) {
      lines.push(`     ${c.username}: expects ${c.expected}, Paperless shows ${c.visible ?? "(not checked in a dry run)"}`);
    }
  }
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean", default: false }, "i-have-a-backup": { type: "boolean", default: false } },
  });
  const dryRun = values["dry-run"] === true;
  const settings = loadSettings(process.env);
  if (!settings.PAPERLESS_API_TOKEN) {
    process.stderr.write("PAPERLESS_API_TOKEN is not set\n");
    return 2;
  }

  const gate = evaluateBackupGate(
    await readBackupStatus(settings.BACKUP_STATUS_FILE),
    new Date(),
    values["i-have-a-backup"] === true,
  );
  logger.info("tenancy_migrate_gate", { dry_run: dryRun, ...gate });
  if (!dryRun && !gate.allowed) {
    process.stderr.write(`Refusing to migrate: ${gate.reason}\n(Override with --i-have-a-backup only if you made one yourself.)\n`);
    return 3;
  }

  const pool = new Pool({ connectionString: toNodePostgresUrl(settings.DATABASE_URL) });
  try {
    const db = drizzle(pool, { schema }) as Database;
    const migration = new TenancyMigration({
      db,
      dryRun,
      paperless: new PaperlessGateway(settings.PAPERLESS_BASE_URL, settings.PAPERLESS_API_TOKEN),
      vectorStore: settings.QDRANT_URL
        ? new QdrantVectorStore(settings.QDRANT_URL, { apiKey: settings.QDRANT_API_KEY || undefined })
        : null,
    });
    const result = await migration.run();
    process.stderr.write(`${formatSummary(result, gate)}\n`);
    if (dryRun) return 0;
    return result.verification?.ok === true ? 0 : 1;
  } finally {
    await pool.end();
  }
}

const isEntrypoint = process.argv[1] !== undefined && process.argv[1].endsWith("tenancy/migrate.js");
if (isEntrypoint) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      logger.error("tenancy_migrate_failed", { error: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
