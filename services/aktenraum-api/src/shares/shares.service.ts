import { logger, type QdrantVectorStore } from "@aktenraum/core";
import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";

import type { MemberPrincipal } from "../auth/principal.js";
import { DB, type Database } from "../db/db.module.js";
import {
  documentShares,
  documentSpaces,
  members,
  shareAudit,
  spaceMembers,
  type ShareAccessKindValue,
  type ShareAuditEvent,
  type ShareRole,
} from "../db/schema.js";
import { PaperlessNotFoundError } from "../paperless/errors.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { VECTOR_STORE } from "../rag/rag.module.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { notRemoved } from "../tenancy/removed.js";
import { mirrorDocument } from "../tenancy/paperless-mirror.js";
import { shareActive } from "../tenancy/share-active.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

export interface ShareEntry {
  member_id: number;
  username: string;
  role: ShareRole;
  expires_at: string | null;
  granted_at: string;
  granted_by: string | null;
}

export interface ShareAuditEntry {
  id: number;
  member_id: number;
  member: string | null;
  actor: string | null;
  event: ShareAuditEvent;
  access_kind: ShareAccessKindValue | null;
  at: string;
}

export interface SharedWithMeEntry {
  doc_id: number;
  title: string;
  shared_by: string | null;
  role: ShareRole;
  expires_at: string | null;
}

export interface SharedByMeEntry {
  doc_id: number;
  title: string;
  member: { id: number; username: string };
  role: ShareRole;
  expires_at: string | null;
  granted_at: string;
}

export interface GrantRequest {
  member_id: number;
  role: ShareRole;
  expires_at?: string | null;
}

export interface ChangeRequest {
  role?: ShareRole;
  /** null clears the expiry; absent leaves it. */
  expires_at?: string | null;
}

/** How often the expiry sweep runs (design §6: Paperless + Ask lose access within 15 min). */
export const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const SHARE_AUDIT_LIMIT = 500;

type ShareRow = typeof documentShares.$inferSelect;

/**
 * Per-document shares (ADR-009, tenancy-document-shares).
 *
 * aktenraum's `document_shares` is the source of truth; Paperless permissions
 * and the Qdrant `shared_with` are derived. Every grant, change and revoke runs
 * DB → Paperless → Qdrant and is undone when a later step fails (same pattern
 * as moving a document), so a share takes effect everywhere or nowhere.
 * Expired shares count as absent in SQL at once; `expireDue` then removes them
 * from Paperless and Qdrant and deletes the row.
 */
@Injectable()
export class SharesService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly gateways: MemberGateways,
    private readonly tenancy: TenancyService,
    @Inject(VECTOR_STORE) private readonly vectorStore: QdrantVectorStore | null,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.expireDue().catch((error: unknown) => {
        logger.error("share_expiry_sweep_failed", { error: errorText(error) });
      });
    }, EXPIRY_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ queries

  async list(docId: number): Promise<ShareEntry[]> {
    const rows = await this.db
      .select()
      .from(documentShares)
      .where(and(eq(documentShares.paperlessDocId, docId), shareActive))
      .orderBy(asc(documentShares.memberId));
    const names = await this.tenancy.usernamesOf(rows.flatMap((r) => [r.memberId, r.grantedBy]));
    return rows.map((r) => this.entry(r, names));
  }

  async audit(docId: number): Promise<ShareAuditEntry[]> {
    const rows = await this.db
      .select()
      .from(shareAudit)
      .where(eq(shareAudit.paperlessDocId, docId))
      .orderBy(desc(shareAudit.at), desc(shareAudit.id))
      .limit(SHARE_AUDIT_LIMIT);
    const names = await this.tenancy.usernamesOf(
      rows.flatMap((r) => (r.actorMemberId === null ? [r.memberId] : [r.memberId, r.actorMemberId])),
    );
    return rows.map((r) => ({
      id: r.id,
      member_id: r.memberId,
      member: names.get(r.memberId) ?? null,
      actor: r.actorMemberId === null ? null : (names.get(r.actorMemberId) ?? null),
      event: r.event,
      access_kind: r.accessKind ?? null,
      at: r.at,
    }));
  }

  async withMe(caller: MemberPrincipal): Promise<SharedWithMeEntry[]> {
    await this.expireDue(caller.memberId);
    const shares = [...(await this.tenancy.sharesReceivedBy(caller.memberId)).values()];
    if (shares.length === 0) return [];
    const titles = await this.titles(await this.gateways.forPrincipal(caller), shares.map((s) => s.docId));
    const names = await this.tenancy.usernamesOf(shares.map((s) => s.grantedBy));
    return shares
      .filter((s) => titles.has(s.docId))
      .sort((a, b) => a.docId - b.docId)
      .map((s) => ({
        doc_id: s.docId,
        title: titles.get(s.docId) ?? "",
        shared_by: names.get(s.grantedBy) ?? null,
        role: s.role,
        expires_at: s.expiresAt,
      }));
  }

  /** Shares on documents whose home space the caller owns — follows a move, unlike "rows I granted". */
  async byMe(caller: MemberPrincipal): Promise<SharedByMeEntry[]> {
    await this.expireDue();
    const rows = await this.db
      .select({
        docId: documentShares.paperlessDocId,
        memberId: documentShares.memberId,
        role: documentShares.role,
        expiresAt: documentShares.expiresAt,
        grantedAt: documentShares.grantedAt,
      })
      .from(documentShares)
      .innerJoin(documentSpaces, eq(documentSpaces.paperlessDocId, documentShares.paperlessDocId))
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, documentSpaces.spaceId))
      .where(and(eq(spaceMembers.memberId, caller.memberId), eq(spaceMembers.role, "owner"), shareActive))
      .orderBy(asc(documentShares.paperlessDocId), asc(documentShares.memberId));
    if (rows.length === 0) return [];
    const titles = await this.titles(await this.gateways.forPrincipal(caller), rows.map((r) => r.docId));
    const names = await this.tenancy.usernamesOf(rows.map((r) => r.memberId));
    return rows
      .filter((r) => titles.has(r.docId))
      .map((r) => ({
        doc_id: r.docId,
        title: titles.get(r.docId) ?? "",
        member: { id: r.memberId, username: names.get(r.memberId) ?? "" },
        role: r.role,
        expires_at: r.expiresAt,
        granted_at: r.grantedAt,
      }));
  }

  // ------------------------------------------------------------------ changes

  /** The route's `@DocumentAccess("share")` has made sure the caller owns the home space. */
  async grant(caller: MemberPrincipal, docId: number, request: GrantRequest): Promise<ShareEntry> {
    if (request.member_id === caller.memberId) {
      throw new UnprocessableEntityException("Ein Dokument lässt sich nicht mit sich selbst teilen");
    }
    await this.assertHouseholdMember(caller, request.member_id);
    const expiresAt = request.expires_at ?? null;
    if (expiresAt !== null) await this.assertFuture(expiresAt);
    await this.assertNotInHomeSpace(docId, request.member_id);

    const existing = await this.row(docId, request.member_id);
    if (existing !== null) {
      if (await this.isActive(existing.id)) throw new ConflictException("Das Dokument ist mit diesem Mitglied bereits geteilt");
      // An expired row the sweep hasn't reached yet: it ends here.
      await this.db.delete(documentShares).where(eq(documentShares.id, existing.id));
      await this.writeAudit(docId, existing.memberId, null, "expired");
    }

    const [created] = await this.db
      .insert(documentShares)
      .values({
        paperlessDocId: docId,
        memberId: request.member_id,
        role: request.role,
        expiresAt,
        grantedBy: caller.memberId,
      })
      .returning();
    await this.applyOrUndo(docId, "grant", async () => {
      await this.db.delete(documentShares).where(eq(documentShares.id, created!.id));
    });
    await this.writeAudit(docId, request.member_id, caller.memberId, "granted");
    logger.info("share_granted", { doc_id: docId, member_id: request.member_id, role: request.role, by: caller.memberId });
    const names = await this.tenancy.usernamesOf([created!.memberId, created!.grantedBy]);
    return this.entry(created!, names);
  }

  async change(caller: MemberPrincipal, docId: number, memberId: number, request: ChangeRequest): Promise<ShareEntry> {
    const current = await this.activeRow(docId, memberId);
    const role = request.role ?? current.role;
    const expiresAt = request.expires_at === undefined ? current.expiresAt : request.expires_at;
    if (request.expires_at !== undefined && request.expires_at !== null) await this.assertFuture(request.expires_at);
    const roleChanged = role !== current.role;
    const expiryChanged = request.expires_at !== undefined && !this.sameInstant(current.expiresAt, expiresAt);
    if (roleChanged || expiryChanged) {
      const where = eq(documentShares.id, current.id);
      await this.db.update(documentShares).set({ role, expiresAt }).where(where);
      await this.applyOrUndo(docId, "change", async () => {
        await this.db.update(documentShares).set({ role: current.role, expiresAt: current.expiresAt }).where(where);
      });
      if (roleChanged) await this.writeAudit(docId, memberId, caller.memberId, "role_changed");
      if (expiryChanged) await this.writeAudit(docId, memberId, caller.memberId, "expiry_changed");
      logger.info("share_changed", { doc_id: docId, member_id: memberId, role, by: caller.memberId });
    }
    const updated = (await this.row(docId, memberId))!;
    const names = await this.tenancy.usernamesOf([updated.memberId, updated.grantedBy]);
    return this.entry(updated, names);
  }

  async revoke(caller: MemberPrincipal, docId: number, memberId: number): Promise<void> {
    const current = await this.activeRow(docId, memberId);
    await this.db.delete(documentShares).where(eq(documentShares.id, current.id));
    await this.applyOrUndo(docId, "revoke", async () => {
      const { id: _id, ...values } = current;
      await this.db.insert(documentShares).values(values).onConflictDoNothing();
    });
    await this.writeAudit(docId, memberId, caller.memberId, "revoked");
    logger.info("share_revoked", { doc_id: docId, member_id: memberId, by: caller.memberId });
  }

  /**
   * Ends shares whose expiry has passed: Paperless and Qdrant first (their
   * targets already leave expired rows out), then the row goes and `expired`
   * is audited. A failure keeps the row, so the next run retries. With
   * `memberId`, only that recipient's shares (the cheap per-request check at
   * the start of lists); without, everything (the periodic sweep).
   */
  async expireDue(memberId?: number): Promise<number> {
    const conditions = [isNotNull(documentShares.expiresAt), sql`${documentShares.expiresAt} <= now()`];
    if (memberId !== undefined) conditions.push(eq(documentShares.memberId, memberId));
    const due = await this.db.select().from(documentShares).where(and(...conditions));
    if (due.length === 0) return 0;
    let expired = 0;
    const byDoc = new Map<number, ShareRow[]>();
    for (const row of due) byDoc.set(row.paperlessDocId, [...(byDoc.get(row.paperlessDocId) ?? []), row]);
    for (const [docId, rows] of byDoc) {
      try {
        await this.applyDerived(docId);
      } catch (error: unknown) {
        logger.error("share_expiry_failed", { doc_id: docId, error: errorText(error) });
        continue;
      }
      for (const row of rows) {
        // Conditional: a concurrent extension (PATCH expires_at) wins.
        const deleted = await this.db
          .delete(documentShares)
          .where(and(eq(documentShares.id, row.id), sql`${documentShares.expiresAt} <= now()`))
          .returning({ id: documentShares.id });
        if (deleted.length === 0) continue;
        await this.writeAudit(docId, row.memberId, null, "expired");
        logger.info("share_expired", { doc_id: docId, member_id: row.memberId });
        expired += 1;
      }
    }
    return expired;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Paperless (service gateway: only the document's Paperless owner may change
   * permissions, and that can be someone else after a move) and then the
   * Qdrant payload. A document that is gone from Paperless (trashed, deleted)
   * has nothing left to mirror.
   */
  private async applyDerived(docId: number): Promise<void> {
    try {
      await mirrorDocument(this.db, this.gatewayProvider.service(), docId);
    } catch (error: unknown) {
      if (!(error instanceof PaperlessNotFoundError)) throw error;
      logger.warn("share_mirror_document_missing", { doc_id: docId });
    }
    if (this.vectorStore !== null) {
      const { spaceId, sharedWith } = await this.tenancy.qdrantSpaceFor(docId);
      await this.vectorStore.setSpaceByDocId(docId, { spaceId, sharedWith });
    }
  }

  private async applyOrUndo(docId: number, op: string, undo: () => Promise<void>): Promise<void> {
    try {
      await this.applyDerived(docId);
    } catch (error: unknown) {
      logger.error("share_apply_failed", { doc_id: docId, op, error: errorText(error) });
      await undo();
      try {
        await this.applyDerived(docId);
      } catch (inner: unknown) {
        logger.error("share_compensation_failed", { doc_id: docId, op, error: errorText(inner) });
      }
      throw new BadGatewayException("Teilen fehlgeschlagen; die Freigabe bleibt unverändert");
    }
  }

  private async writeAudit(
    docId: number,
    memberId: number,
    actorMemberId: number | null,
    event: ShareAuditEvent,
  ): Promise<void> {
    try {
      await this.db.insert(shareAudit).values({ paperlessDocId: docId, memberId, actorMemberId, event });
    } catch (error: unknown) {
      logger.warn("share_audit_failed", { doc_id: docId, member_id: memberId, event, error: errorText(error) });
    }
  }

  private async row(docId: number, memberId: number): Promise<ShareRow | null> {
    const rows = await this.db
      .select()
      .from(documentShares)
      .where(and(eq(documentShares.paperlessDocId, docId), eq(documentShares.memberId, memberId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async activeRow(docId: number, memberId: number): Promise<ShareRow> {
    const rows = await this.db
      .select()
      .from(documentShares)
      .where(and(eq(documentShares.paperlessDocId, docId), eq(documentShares.memberId, memberId), shareActive))
      .limit(1);
    if (rows[0] === undefined) throw new NotFoundException(`Share for member ${memberId} not found`);
    return rows[0];
  }

  private async isActive(shareId: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: documentShares.id })
      .from(documentShares)
      .where(and(eq(documentShares.id, shareId), shareActive))
      .limit(1);
    return rows.length > 0;
  }

  /** The expiry must lie in the future — by the database clock, like every expiry check. */
  private async assertFuture(expiresAt: string): Promise<void> {
    const result = await this.db.execute<{ future: boolean }>(sql`SELECT (${expiresAt}::timestamptz > now()) AS future`);
    if (result.rows[0]?.future !== true) {
      throw new UnprocessableEntityException("Das Ablaufdatum liegt in der Vergangenheit");
    }
  }

  private sameInstant(a: string | null, b: string | null): boolean {
    if (a === null || b === null) return a === b;
    return new Date(a).getTime() === new Date(b).getTime();
  }

  private async assertHouseholdMember(caller: MemberPrincipal, memberId: number): Promise<void> {
    const rows = await this.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), eq(members.householdId, caller.householdId), notRemoved(members.id)))
      .limit(1);
    if (rows.length === 0) throw new UnprocessableEntityException(`Mitglied ${memberId} gibt es nicht`);
  }

  private async assertNotInHomeSpace(docId: number, memberId: number): Promise<void> {
    const rows = await this.db
      .select({ role: spaceMembers.role })
      .from(documentSpaces)
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, documentSpaces.spaceId))
      .where(and(eq(documentSpaces.paperlessDocId, docId), eq(spaceMembers.memberId, memberId)))
      .limit(1);
    if (rows.length > 0) {
      throw new ConflictException("Das Mitglied hat über die Akte bereits Zugriff");
    }
  }

  /** Titles of the documents the caller can still read (trashed ones are left out). */
  private async titles(gateway: PaperlessGateway, docIds: readonly number[]): Promise<Map<number, string>> {
    const ids = [...new Set(docIds)];
    const out = new Map<number, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const payload = await gateway.searchDocuments(
        { id__in: chunk.join(","), fields: "id,title", page: 1 },
        { pageSize: chunk.length },
      );
      for (const doc of (payload.results as PaperlessDocument[] | undefined) ?? []) {
        out.set(Number(doc.id), typeof doc.title === "string" ? doc.title : "");
      }
    }
    return out;
  }

  private entry(row: ShareRow, names: Map<number, string>): ShareEntry {
    return {
      member_id: row.memberId,
      username: names.get(row.memberId) ?? "",
      role: row.role,
      expires_at: row.expiresAt,
      granted_at: row.grantedAt,
      granted_by: names.get(row.grantedBy) ?? null,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
