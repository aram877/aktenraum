import { logger, type QdrantVectorStore } from "@aktenraum/core";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { MemberPrincipal } from "../auth/principal.js";
import { DB, type Database } from "../db/db.module.js";
import {
  documentShares,
  documentSpaces,
  memberPaperlessTokens,
  memberRemovalDocuments,
  memberRemovals,
  members,
  shareAudit,
  spaceMembers,
  spaces,
  users,
  type MemberRemovalPhase,
} from "../db/schema.js";
import { PaperlessNotFoundError } from "../paperless/errors.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { VECTOR_STORE } from "../rag/rag.module.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { mirrorDocument, syncSpaceMembership } from "../tenancy/paperless-mirror.js";
import { notRemoved } from "../tenancy/removed.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

export const REMOVAL_SYNC_INTERVAL_MS = 5 * 60_000;

export type RemovalStatus = "done" | "completing";

export interface RemovalResult {
  member_id: number;
  successor_member_id: number;
  status: RemovalStatus;
}

export interface RemovalPreview {
  member_id: number;
  username: string;
  successor_member_id: number;
  successor: string;
  /** Documents whose home space is the member's personal space (trashed ones included). */
  documents: number;
  /** Of those, in the Paperless trash; null when Paperless couldn't be asked. */
  trashed: number | null;
  spaces_owned: { id: number; name: string }[];
  spaces_left: { id: number; name: string }[];
  shares_revoked: number;
  shares_kept: number;
}

export interface RemovalEntry {
  member_id: number;
  username: string;
  successor: string;
  removed_at: string;
  status: RemovalStatus;
  last_error: string | null;
}

interface RemovalRow {
  memberId: number;
  successorId: number;
  removedBy: number;
  phase: MemberRemovalPhase;
}

interface Target {
  member: { id: number; username: string };
  successor: { id: number; username: string };
}

/**
 * Removing a household member (tenancy-member-removal, ADR-009): validate,
 * lock the member out (the `member_removals` insert *is* the lockout), then
 * two resumable phases — `db` (documents, spaces, shares move to the
 * successor) and `derived` (Paperless user deactivated, permissions and the
 * Qdrant payload re-mirrored per document). Every step is idempotent; a
 * failure only delays completion, which the periodic sync finishes.
 */
@Injectable()
export class MemberRemovalService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  /** Per-member lock: a request and the sync never run the same removal at once. */
  private readonly running = new Map<number, Promise<RemovalStatus>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly gateways: MemberGateways,
    private readonly tenancy: TenancyService,
    @Inject(VECTOR_STORE) private readonly vectorStore: QdrantVectorStore | null,
  ) {}

  onApplicationBootstrap(): void {
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), REMOVAL_SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ routes

  async preview(admin: MemberPrincipal, memberId: number, successorId?: number): Promise<RemovalPreview> {
    const { member, successor } = await this.validate(admin, memberId, successorId);
    const personal = await this.personalSpaceId(member.id);
    const personalDocs = personal === null ? [] : await this.tenancy.spaceDocumentIds(personal);
    const owned = await this.ownedSharedSpaces(member.id);
    const left = await this.otherSharedSpaces(member.id);

    let trashed: number | null = null;
    if (personalDocs.length > 0) {
      try {
        const inTrash = await this.trashedIds(this.gatewayProvider.service());
        trashed = personalDocs.filter((id) => inTrash.has(id)).length;
      } catch (error: unknown) {
        logger.warn("member_removal_preview_trash_unavailable", { member_id: member.id, error: errorText(error) });
      }
    } else {
      trashed = 0;
    }

    const received = await this.db
      .select({ id: documentShares.id })
      .from(documentShares)
      .where(eq(documentShares.memberId, member.id));
    // Shares on documents that pass to the successor: kept, unless the
    // recipient is the successor or a member of the document's (shared) space.
    const handedOver = [...personalDocs];
    const ownedMembers = new Map<number, Set<number>>();
    for (const space of owned) {
      const docs = await this.tenancy.spaceDocumentIds(space.id);
      handedOver.push(...docs);
      const rows = await this.db
        .select({ memberId: spaceMembers.memberId })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, space.id));
      const set = new Set(rows.map((r) => r.memberId));
      for (const doc of docs) ownedMembers.set(doc, set);
    }
    let revokedOnHandover = 0;
    let kept = 0;
    if (handedOver.length > 0) {
      const shares = await this.db
        .select({ docId: documentShares.paperlessDocId, memberId: documentShares.memberId })
        .from(documentShares)
        .where(inArray(documentShares.paperlessDocId, handedOver));
      for (const share of shares) {
        const inSpace = share.memberId === successor.id || (ownedMembers.get(share.docId)?.has(share.memberId) ?? false);
        if (inSpace) revokedOnHandover += 1;
        else kept += 1;
      }
    }

    return {
      member_id: member.id,
      username: member.username,
      successor_member_id: successor.id,
      successor: successor.username,
      documents: personalDocs.length,
      trashed,
      spaces_owned: owned,
      spaces_left: left,
      shares_revoked: received.length + revokedOnHandover,
      shares_kept: kept,
    };
  }

  async remove(
    admin: MemberPrincipal,
    memberId: number,
    body: { confirm_username: string; successor_member_id?: number },
  ): Promise<RemovalResult> {
    const { member, successor } = await this.validate(admin, memberId, body.successor_member_id);
    if (body.confirm_username.trim() !== member.username) {
      throw new UnprocessableEntityException("Der Benutzername stimmt nicht überein");
    }

    // The lockout: from this insert on, sessions answer 401 and login fails.
    const inserted = await this.db
      .insert(memberRemovals)
      .values({ memberId: member.id, successorId: successor.id, removedBy: admin.memberId, phase: "db" })
      .onConflictDoNothing()
      .returning({ memberId: memberRemovals.memberId });
    if (inserted.length === 0) throw new NotFoundException(`Member ${memberId} not found`);
    this.gateways.forget(member.id);
    await this.db.delete(memberPaperlessTokens).where(eq(memberPaperlessTokens.memberId, member.id));
    logger.info("member_removed", { member_id: member.id, successor_id: successor.id, by_member: admin.memberId });

    const status = await this.complete(member.id);
    return { member_id: member.id, successor_member_id: successor.id, status };
  }

  async list(): Promise<RemovalEntry[]> {
    const rows = await this.db
      .select({
        memberId: memberRemovals.memberId,
        successorId: memberRemovals.successorId,
        removedAt: memberRemovals.removedAt,
        phase: memberRemovals.phase,
        lastError: memberRemovals.lastError,
      })
      .from(memberRemovals)
      .orderBy(asc(memberRemovals.removedAt), asc(memberRemovals.memberId));
    const names = await this.tenancy.usernamesOf(rows.flatMap((r) => [r.memberId, r.successorId]));
    return rows.map((r) => ({
      member_id: r.memberId,
      username: names.get(r.memberId) ?? "",
      successor: names.get(r.successorId) ?? "",
      removed_at: r.removedAt,
      status: r.phase === "done" ? "done" : "completing",
      last_error: r.phase === "done" ? null : r.lastError,
    }));
  }

  // ------------------------------------------------------------------ sync

  /** Finishes every removal that isn't done yet (startup + every 5 minutes). */
  async syncAll(): Promise<void> {
    try {
      const open = await this.db
        .select({ memberId: memberRemovals.memberId })
        .from(memberRemovals)
        .where(ne(memberRemovals.phase, "done"))
        .orderBy(asc(memberRemovals.memberId));
      for (const { memberId } of open) await this.complete(memberId);
    } catch (error: unknown) {
      logger.error("member_removal_sync_failed", { error: errorText(error) });
    }
  }

  /** Runs the outstanding phases of one removal; shares a run already in progress. */
  complete(memberId: number): Promise<RemovalStatus> {
    const running = this.running.get(memberId);
    if (running !== undefined) return running;
    const work = this.run(memberId).finally(() => this.running.delete(memberId));
    this.running.set(memberId, work);
    return work;
  }

  private async run(memberId: number): Promise<RemovalStatus> {
    const removal = await this.removal(memberId);
    if (removal === null) throw new NotFoundException(`No removal for member ${memberId}`);
    if (removal.phase === "done") return "done";
    await this.db
      .update(memberRemovals)
      .set({ attempts: sql`${memberRemovals.attempts} + 1` as unknown as number })
      .where(eq(memberRemovals.memberId, memberId));
    try {
      if (removal.phase === "db") await this.runDbPhase(removal);
      await this.runDerivedPhase(removal);
    } catch (error: unknown) {
      const message = errorText(error).slice(0, 500);
      await this.db.update(memberRemovals).set({ lastError: message }).where(eq(memberRemovals.memberId, memberId));
      logger.warn("member_removal_incomplete", { member_id: memberId, error: message });
      return "completing";
    }
    logger.info("member_removal_completed", { member_id: memberId, successor_id: removal.successorId });
    return "done";
  }

  // ------------------------------------------------------------------ phase db

  /**
   * Database changes, each idempotent: record the affected documents, move the
   * personal space's documents, hand over owned shared spaces, leave the
   * others, end the shares that no longer make sense.
   */
  private async runDbPhase(removal: RemovalRow): Promise<void> {
    const { memberId, successorId, removedBy } = removal;
    const personal = await this.personalSpaceId(memberId);
    const successorPersonal = await this.requirePersonalSpace(successorId);
    const owned = await this.ownedSharedSpaces(memberId);

    // 1. Affected documents (recorded before anything moves, so a resumed run still knows them).
    const affected = new Set<number>();
    if (personal !== null) for (const id of await this.tenancy.spaceDocumentIds(personal)) affected.add(id);
    for (const space of owned) for (const id of await this.tenancy.spaceDocumentIds(space.id)) affected.add(id);
    for (const row of await this.db
      .select({ docId: documentShares.paperlessDocId })
      .from(documentShares)
      .where(eq(documentShares.memberId, memberId))) {
      affected.add(row.docId);
    }
    if (affected.size > 0) {
      await this.db
        .insert(memberRemovalDocuments)
        .values([...affected].map((paperlessDocId) => ({ memberId, paperlessDocId })))
        .onConflictDoNothing();
    }

    // 2. Personal documents → the successor's personal space.
    if (personal !== null) {
      await this.db
        .update(documentSpaces)
        .set({ spaceId: successorPersonal, assignedAt: sql`now()` as unknown as string })
        .where(eq(documentSpaces.spaceId, personal));
    }

    // 3. Owned shared spaces → the successor is the single owner (promoted from editor/viewer).
    for (const space of owned) {
      await this.db
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.memberId, successorId), ne(spaceMembers.role, "owner")));
      const existing = await this.db
        .select({ role: spaceMembers.role })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.memberId, successorId)))
        .limit(1);
      if (existing.length > 0) {
        // Already a co-owner (not expected with single owners): just drop the removed member.
        await this.db
          .delete(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.memberId, memberId)));
      } else {
        await this.db
          .update(spaceMembers)
          .set({ memberId: successorId })
          .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.memberId, memberId), eq(spaceMembers.role, "owner")));
      }
      logger.info("member_removal_space_handed_over", { member_id: memberId, space_id: space.id, successor_id: successorId });
    }

    // 4. Leave every other shared space.
    await this.db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.memberId, memberId), inArray(spaceMembers.role, ["editor", "viewer"])));

    // 5. Shares: those the member received, and those whose recipient now has
    //    the document through its home space (typically the successor).
    for (const share of await this.db
      .select({ id: documentShares.id, docId: documentShares.paperlessDocId, memberId: documentShares.memberId })
      .from(documentShares)
      .where(eq(documentShares.memberId, memberId))) {
      await this.revokeShare(share, removedBy);
    }
    // Only documents that now live in a space the successor owns (the handed-over ones).
    const successorOwned = (
      await this.db
        .select({ spaceId: spaceMembers.spaceId })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.memberId, successorId), eq(spaceMembers.role, "owner")))
    ).map((r) => r.spaceId);
    const recorded = await this.recordedDocuments(memberId);
    if (recorded.length > 0 && successorOwned.length > 0) {
      const redundant = await this.db
        .select({ id: documentShares.id, docId: documentShares.paperlessDocId, memberId: documentShares.memberId })
        .from(documentShares)
        .innerJoin(documentSpaces, eq(documentSpaces.paperlessDocId, documentShares.paperlessDocId))
        .innerJoin(
          spaceMembers,
          and(eq(spaceMembers.spaceId, documentSpaces.spaceId), eq(spaceMembers.memberId, documentShares.memberId)),
        )
        .where(and(inArray(documentShares.paperlessDocId, recorded), inArray(documentSpaces.spaceId, successorOwned)));
      for (const share of redundant) await this.revokeShare(share, removedBy);
    }

    await this.db
      .update(memberRemovals)
      .set({ phase: "derived" })
      .where(and(eq(memberRemovals.memberId, memberId), eq(memberRemovals.phase, "db")));
    removal.phase = "derived";
  }

  /** Deletes one share row and audits `revoked` by the admin, exactly once per row. */
  private async revokeShare(share: { id: number; docId: number; memberId: number }, actor: number): Promise<void> {
    const deleted = await this.db
      .delete(documentShares)
      .where(eq(documentShares.id, share.id))
      .returning({ id: documentShares.id });
    if (deleted.length === 0) return;
    await this.db.insert(shareAudit).values({
      paperlessDocId: share.docId,
      memberId: share.memberId,
      actorMemberId: actor,
      event: "revoked",
    });
    logger.info("member_removal_share_revoked", { doc_id: share.docId, member_id: share.memberId });
  }

  // ------------------------------------------------------------------ phase derived

  /**
   * Paperless + Qdrant, each idempotent: deactivate the member's Paperless
   * user (one PATCH also drops every group), bring the successor's group
   * memberships in line, then re-mirror every affected document not yet synced.
   */
  private async runDerivedPhase(removal: RemovalRow): Promise<void> {
    const { memberId, successorId } = removal;
    const service = this.gatewayProvider.service();

    const paperlessUserId = (
      await this.db.select({ id: members.paperlessUserId }).from(members).where(eq(members.id, memberId)).limit(1)
    )[0]?.id;
    if (paperlessUserId !== null && paperlessUserId !== undefined) await service.deactivateUser(paperlessUserId);

    for (const spaceId of await this.tenancy.spaceIdsOf(successorId)) {
      await syncSpaceMembership(this.db, service, spaceId);
    }

    const pending = await this.db
      .select({ docId: memberRemovalDocuments.paperlessDocId, trashed: memberRemovalDocuments.trashed })
      .from(memberRemovalDocuments)
      .where(and(eq(memberRemovalDocuments.memberId, memberId), isNull(memberRemovalDocuments.syncedAt)))
      .orderBy(asc(memberRemovalDocuments.paperlessDocId));
    let trash: Set<number> | null = null;
    const inTrash = async (docId: number): Promise<boolean> => {
      trash ??= await this.trashedIds(service);
      return trash.has(docId);
    };
    for (const row of pending) {
      const exists = await this.syncDocument(service, memberId, row.docId, row.trashed, inTrash);
      if (exists && this.vectorStore !== null) {
        await this.vectorStore.setSpaceByDocId(row.docId, await this.tenancy.qdrantSpaceFor(row.docId));
      }
      await this.db
        .update(memberRemovalDocuments)
        .set({ syncedAt: sql`now()` as unknown as string })
        .where(and(eq(memberRemovalDocuments.memberId, memberId), eq(memberRemovalDocuments.paperlessDocId, row.docId)));
    }

    this.gateways.forget(successorId);
    await this.db
      .update(memberRemovals)
      .set({ phase: "done", completedAt: sql`now()` as unknown as string, lastError: null })
      .where(eq(memberRemovals.memberId, memberId));
    removal.phase = "done";
  }

  /**
   * Mirrors one document. A trashed one (Paperless hides it from
   * `/documents/{id}/`) is restored, mirrored and trashed again, so its new
   * owner sees it in their trash; the `trashed` flag is stored first so a
   * resumed run re-trashes it. A document in neither place was hard-deleted:
   * its home-space and share rows go. Returns whether the document exists.
   */
  private async syncDocument(
    service: PaperlessGateway,
    memberId: number,
    docId: number,
    trashed: boolean,
    inTrash: (docId: number) => Promise<boolean>,
  ): Promise<boolean> {
    if (!trashed) {
      try {
        await mirrorDocument(this.db, service, docId);
        return true;
      } catch (error: unknown) {
        if (!(error instanceof PaperlessNotFoundError)) throw error;
      }
      if (!(await inTrash(docId))) {
        await this.db.delete(documentShares).where(eq(documentShares.paperlessDocId, docId));
        await this.db.delete(documentSpaces).where(eq(documentSpaces.paperlessDocId, docId));
        logger.info("member_removal_document_vanished", { member_id: memberId, doc_id: docId });
        return false;
      }
      await this.db
        .update(memberRemovalDocuments)
        .set({ trashed: true })
        .where(and(eq(memberRemovalDocuments.memberId, memberId), eq(memberRemovalDocuments.paperlessDocId, docId)));
    }
    // Trashed: the document is in the trash, or still restored from an interrupted run.
    try {
      await mirrorDocument(this.db, service, docId);
    } catch (error: unknown) {
      if (!(error instanceof PaperlessNotFoundError)) throw error;
      await service.restoreDocuments([docId]);
      await mirrorDocument(this.db, service, docId);
    }
    await service.deleteDocument(docId);
    logger.info("member_removal_trashed_document_mirrored", { member_id: memberId, doc_id: docId });
    return true;
  }

  // ------------------------------------------------------------------ helpers

  private async validate(admin: MemberPrincipal, memberId: number, successorId?: number): Promise<Target> {
    const member = await this.currentMember(admin.householdId, memberId);
    if (member === null) throw new NotFoundException(`Member ${memberId} not found`);
    if (member.id === admin.memberId) throw new ConflictException("Du kannst dich nicht selbst entfernen");
    if (member.role === "admin") throw new ConflictException("Der Haushalts-Admin kann nicht entfernt werden");
    const wanted = successorId ?? admin.memberId;
    const successor = wanted === member.id ? null : await this.currentMember(admin.householdId, wanted);
    if (successor === null) throw new UnprocessableEntityException("Ungültiger Nachfolger");
    return {
      member: { id: member.id, username: member.username },
      successor: { id: successor.id, username: successor.username },
    };
  }

  /** A member of the household that isn't removed, or null. */
  private async currentMember(
    householdId: number,
    memberId: number,
  ): Promise<{ id: number; username: string; role: "admin" | "member" } | null> {
    const rows = await this.db
      .select({ id: members.id, username: users.username, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.id, memberId), eq(members.householdId, householdId), notRemoved(members.id)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async removal(memberId: number): Promise<RemovalRow | null> {
    const rows = await this.db
      .select({
        memberId: memberRemovals.memberId,
        successorId: memberRemovals.successorId,
        removedBy: memberRemovals.removedBy,
        phase: memberRemovals.phase,
      })
      .from(memberRemovals)
      .where(eq(memberRemovals.memberId, memberId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async recordedDocuments(memberId: number): Promise<number[]> {
    const rows = await this.db
      .select({ docId: memberRemovalDocuments.paperlessDocId })
      .from(memberRemovalDocuments)
      .where(eq(memberRemovalDocuments.memberId, memberId));
    return rows.map((r) => r.docId);
  }

  private async personalSpaceId(memberId: number): Promise<number | null> {
    const rows = await this.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.personalMemberId, memberId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private async requirePersonalSpace(memberId: number): Promise<number> {
    const found = await this.personalSpaceId(memberId);
    if (found !== null) return found;
    await this.tenancy.reconcile();
    const again = await this.personalSpaceId(memberId);
    if (again === null) throw new Error(`member ${memberId} has no personal space`);
    return again;
  }

  private async ownedSharedSpaces(memberId: number): Promise<{ id: number; name: string }[]> {
    return this.db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.memberId, memberId), eq(spaceMembers.role, "owner"), eq(spaces.kind, "shared")))
      .orderBy(asc(spaces.id));
  }

  private async otherSharedSpaces(memberId: number): Promise<{ id: number; name: string }[]> {
    return this.db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.memberId, memberId), inArray(spaceMembers.role, ["editor", "viewer"])))
      .orderBy(asc(spaces.id));
  }

  /** Ids in the Paperless trash, read with the service gateway (sees every owner's trash). */
  private async trashedIds(service: PaperlessGateway): Promise<Set<number>> {
    const ids = new Set<number>();
    for (let page = 1; page <= 100; page += 1) {
      const payload = await service.listTrashedDocuments({ page, pageSize: 100 });
      for (const doc of (payload.results as PaperlessDocument[] | undefined) ?? []) ids.add(Number(doc.id));
      if (!payload.next) break;
    }
    return ids;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
