import { logger, type QdrantVectorStore } from "@aktenraum/core";
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";

import type { MemberPrincipal } from "../auth/principal.js";
import { DB, type Database } from "../db/db.module.js";
import {
  documentSpaces,
  members,
  spaceMembers,
  spacePaperlessGroups,
  spaces,
  uploadTaskSpaces,
  users,
  type SpaceKind,
  type SpaceRole,
} from "../db/schema.js";
import { PaperlessNotFoundError } from "../paperless/errors.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { PolicyService } from "../policy/policy.service.js";
import { VECTOR_STORE } from "../rag/rag.module.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { notRemoved } from "../tenancy/removed.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import {
  mirrorDocument,
  removeFromSpaceGroups,
  syncSpaceMembership,
} from "../tenancy/paperless-mirror.js";

export type MemberRole = Exclude<SpaceRole, "owner">;

export interface SpaceSummary {
  id: number;
  name: string;
  kind: SpaceKind;
  /** The caller's role in the space. */
  role: SpaceRole;
  /** Username of the space's owner. */
  owner: string | null;
  member_count: number;
  document_count: number;
}

export interface SpaceList {
  household_member_count: number;
  spaces: SpaceSummary[];
}

export interface SpaceMemberEntry {
  member_id: number;
  username: string;
  role: SpaceRole;
}

export interface DirectoryEntry {
  id: number;
  username: string;
}

export type MoveStatus = "moved" | "unchanged" | "forbidden" | "not_found" | "failed";

export interface MoveResult {
  doc_id: number;
  status: MoveStatus;
  detail?: string;
}

export const BULK_MOVE_LIMIT = 200;

/** A refusal for one document, before anything was written. */
class MoveRefused extends Error {
  constructor(readonly status: "forbidden" | "not_found" | "failed", detail: string) {
    super(detail);
  }
}

/**
 * Shared spaces ("Akten", ADR-009 / tenancy-shared-spaces): creating, renaming
 * and deleting them, their membership, and moving documents between spaces.
 *
 * aktenraum's tables are the source of truth. Every change that Paperless has
 * to enforce too (group membership, document owner + permissions, the Qdrant
 * `space_id`) is applied right after the DB write and undone when it fails, so
 * the request either takes effect everywhere or nowhere.
 */
@Injectable()
export class SpacesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly gateways: MemberGateways,
    private readonly policy: PolicyService,
    private readonly tenancy: TenancyService,
    @Inject(VECTOR_STORE) private readonly vectorStore: QdrantVectorStore | null,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(caller: MemberPrincipal): Promise<SpaceList> {
    const [household] = await this.db.select({ n: count() }).from(members).where(notRemoved(members.id));
    const mine = await this.db
      .select({ id: spaces.id, name: spaces.name, kind: spaces.kind, role: spaceMembers.role })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.memberId, caller.memberId))
      .orderBy(asc(spaces.id));
    const ids = mine.map((s) => s.id);
    const memberCounts = new Map<number, number>();
    const documentCounts = new Map<number, number>();
    const owners = new Map<number, string>();
    if (ids.length > 0) {
      for (const row of await this.db
        .select({ spaceId: spaceMembers.spaceId, n: count() })
        .from(spaceMembers)
        .where(inArray(spaceMembers.spaceId, ids))
        .groupBy(spaceMembers.spaceId)) {
        memberCounts.set(row.spaceId, Number(row.n));
      }
      for (const row of await this.db
        .select({ spaceId: documentSpaces.spaceId, n: count() })
        .from(documentSpaces)
        .where(inArray(documentSpaces.spaceId, ids))
        .groupBy(documentSpaces.spaceId)) {
        documentCounts.set(row.spaceId, Number(row.n));
      }
      for (const row of await this.db
        .select({ spaceId: spaceMembers.spaceId, username: users.username })
        .from(spaceMembers)
        .innerJoin(members, eq(members.id, spaceMembers.memberId))
        .innerJoin(users, eq(users.id, members.userId))
        .where(and(inArray(spaceMembers.spaceId, ids), eq(spaceMembers.role, "owner")))
        .orderBy(asc(spaceMembers.memberId))) {
        if (!owners.has(row.spaceId)) owners.set(row.spaceId, row.username);
      }
    }
    return {
      household_member_count: Number(household?.n ?? 0),
      spaces: mine.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        role: s.role,
        owner: owners.get(s.id) ?? null,
        member_count: memberCounts.get(s.id) ?? 0,
        document_count: documentCounts.get(s.id) ?? 0,
      })),
    };
  }

  /** The caller's role in a space; 404 when they aren't in it (existence isn't leaked). */
  async roleIn(memberId: number, spaceId: number): Promise<{ role: SpaceRole; kind: SpaceKind; name: string }> {
    const rows = await this.db
      .select({ role: spaceMembers.role, kind: spaces.kind, name: spaces.name })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException(`Space ${spaceId} not found`);
    return row;
  }

  /** Whether a member may put documents into a space (upload, move in): owner or editor. */
  async canPlaceInto(memberId: number, spaceId: number): Promise<boolean> {
    const rows = await this.db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId)))
      .limit(1);
    const role = rows[0]?.role;
    return role === "owner" || role === "editor";
  }

  async listMembers(caller: MemberPrincipal, spaceId: number): Promise<SpaceMemberEntry[]> {
    await this.roleIn(caller.memberId, spaceId);
    const rows = await this.db
      .select({ memberId: spaceMembers.memberId, username: users.username, role: spaceMembers.role })
      .from(spaceMembers)
      .innerJoin(members, eq(members.id, spaceMembers.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(spaceMembers.spaceId, spaceId))
      .orderBy(asc(spaceMembers.memberId));
    return rows.map((r) => ({ member_id: r.memberId, username: r.username, role: r.role }));
  }

  // ------------------------------------------------------------------ spaces

  async create(caller: MemberPrincipal, rawName: string): Promise<SpaceSummary> {
    const name = rawName.trim();
    await this.assertNameFree(caller.memberId, name, null);
    const [space] = await this.db
      .insert(spaces)
      .values({ householdId: caller.householdId, name, kind: "shared" })
      .returning({ id: spaces.id });
    const spaceId = space!.id;
    await this.db.insert(spaceMembers).values({ spaceId, memberId: caller.memberId, role: "owner" });
    try {
      await syncSpaceMembership(this.db, this.gatewayProvider.service(), spaceId);
    } catch (error: unknown) {
      // Nothing can live in the space yet; Paperless catches up on the next
      // membership change or document move into it.
      logger.warn("space_create_paperless_deferred", { space_id: spaceId, error: errorText(error) });
    }
    logger.info("space_created", { space_id: spaceId, member_id: caller.memberId });
    return {
      id: spaceId,
      name,
      kind: "shared",
      role: "owner",
      owner: caller.username,
      member_count: 1,
      document_count: 0,
    };
  }

  async rename(caller: MemberPrincipal, spaceId: number, rawName: string): Promise<void> {
    await this.ownSharedSpace(caller, spaceId);
    const name = rawName.trim();
    await this.assertNameFree(caller.memberId, name, spaceId);
    await this.db.update(spaces).set({ name }).where(eq(spaces.id, spaceId));
    logger.info("space_renamed", { space_id: spaceId, member_id: caller.memberId });
  }

  /**
   * Deletes an empty shared space. Trashed documents keep their
   * `document_spaces` row (Paperless soft delete keeps the id), so "no row"
   * means empty including the trash.
   */
  async remove(caller: MemberPrincipal, spaceId: number): Promise<void> {
    await this.ownSharedSpace(caller, spaceId);
    const [docs] = await this.db
      .select({ n: count() })
      .from(documentSpaces)
      .where(eq(documentSpaces.spaceId, spaceId));
    if (Number(docs?.n ?? 0) > 0) {
      throw new ConflictException("Die Akte enthält noch Dokumente (auch im Papierkorb)");
    }
    const formerMembers = (
      await this.db
        .select({ memberId: spaceMembers.memberId })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, spaceId))
    ).map((r) => r.memberId);
    // The space holds no documents, so its groups grant nothing; leaving users
    // in them is harmless, which is why this is best effort.
    for (const memberId of formerMembers) {
      try {
        await removeFromSpaceGroups(this.db, this.gatewayProvider.service(), memberId, spaceId);
      } catch (error: unknown) {
        logger.warn("space_delete_group_cleanup_failed", {
          space_id: spaceId,
          member_id: memberId,
          error: errorText(error),
        });
      }
      this.gateways.forget(memberId);
    }
    await this.db.delete(uploadTaskSpaces).where(eq(uploadTaskSpaces.spaceId, spaceId));
    await this.db.delete(spacePaperlessGroups).where(eq(spacePaperlessGroups.spaceId, spaceId));
    await this.db.delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
    await this.db.delete(spaces).where(eq(spaces.id, spaceId));
    logger.info("space_deleted", { space_id: spaceId, member_id: caller.memberId });
  }

  // ------------------------------------------------------------------ membership

  async addMember(caller: MemberPrincipal, spaceId: number, memberId: number, role: MemberRole): Promise<SpaceMemberEntry> {
    await this.ownSharedSpace(caller, spaceId);
    const target = await this.householdMember(memberId);
    const existing = await this.db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId)))
      .limit(1);
    if (existing.length > 0) throw new ConflictException("Mitglied ist bereits in dieser Akte");

    await this.db.insert(spaceMembers).values({ spaceId, memberId, role });
    await this.applyMembership(spaceId, memberId, async () => {
      await this.db
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId)));
      await removeFromSpaceGroups(this.db, this.gatewayProvider.service(), memberId, spaceId);
    });
    logger.info("space_member_added", { space_id: spaceId, member_id: memberId, role, by: caller.memberId });
    return { member_id: memberId, username: target.username, role };
  }

  async changeRole(caller: MemberPrincipal, spaceId: number, memberId: number, role: MemberRole): Promise<SpaceMemberEntry> {
    await this.ownSharedSpace(caller, spaceId);
    const current = await this.membership(spaceId, memberId);
    if (current === "owner") throw new ConflictException("Die Rolle des Eigentümers lässt sich nicht ändern");
    const target = await this.householdMember(memberId);
    if (current !== role) {
      const where = and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId));
      await this.db.update(spaceMembers).set({ role }).where(where);
      await this.applyMembership(spaceId, memberId, async () => {
        await this.db.update(spaceMembers).set({ role: current }).where(where);
        await syncSpaceMembership(this.db, this.gatewayProvider.service(), spaceId);
      });
      logger.info("space_member_role_changed", { space_id: spaceId, member_id: memberId, from: current, to: role });
    }
    return { member_id: memberId, username: target.username, role };
  }

  /** The owner removes a member, or a non-owner leaves (memberId = themselves). */
  async removeMember(caller: MemberPrincipal, spaceId: number, memberId: number): Promise<void> {
    const mine = await this.roleIn(caller.memberId, spaceId);
    if (mine.kind === "personal") throw new ConflictException("Persönliche Akten haben genau ein Mitglied");
    const leaving = memberId === caller.memberId;
    if (!leaving && mine.role !== "owner") throw new ForbiddenException("Nur der Eigentümer verwaltet Mitglieder");
    const current = await this.membership(spaceId, memberId);
    if (current === "owner") throw new ConflictException("Der Eigentümer kann die Akte nicht verlassen");

    const where = and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId));
    await this.db.delete(spaceMembers).where(where);
    try {
      await removeFromSpaceGroups(this.db, this.gatewayProvider.service(), memberId, spaceId);
    } catch (error: unknown) {
      await this.db.insert(spaceMembers).values({ spaceId, memberId, role: current }).onConflictDoNothing();
      logger.error("space_member_remove_paperless_failed", { space_id: spaceId, member_id: memberId, error: errorText(error) });
      throw new BadGatewayException("Paperless hat die Änderung abgelehnt; die Mitgliedschaft bleibt unverändert");
    }
    this.gateways.forget(memberId);
    logger.info(leaving ? "space_left" : "space_member_removed", { space_id: spaceId, member_id: memberId });
  }

  // ------------------------------------------------------------------ moving

  /** Single move; the route's `@DocumentAccess("read")` has already hidden unreadable documents. */
  async moveDocument(caller: MemberPrincipal, docId: number, targetSpaceId: number): Promise<MoveResult> {
    await this.assertPlaceable(caller, targetSpaceId);
    try {
      return await this.moveOne(caller, docId, targetSpaceId);
    } catch (error: unknown) {
      if (error instanceof MoveRefused) {
        if (error.status === "not_found") throw new NotFoundException(`Document ${docId} not found`);
        if (error.status === "forbidden") throw new ForbiddenException(error.message);
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async bulkMove(caller: MemberPrincipal, targetSpaceId: number, docIds: readonly number[]): Promise<{ results: MoveResult[] }> {
    await this.assertPlaceable(caller, targetSpaceId);
    const results: MoveResult[] = [];
    for (const docId of [...new Set(docIds)]) {
      try {
        results.push(await this.moveOne(caller, docId, targetSpaceId));
      } catch (error: unknown) {
        if (error instanceof MoveRefused) {
          results.push({ doc_id: docId, status: error.status, detail: error.message });
        } else {
          results.push({ doc_id: docId, status: "failed", detail: errorText(error) });
        }
      }
    }
    return { results };
  }

  /**
   * DB → Paperless → Qdrant, each step undone when a later one fails:
   * 1. conditional update of the home space (a concurrent move loses with 409),
   * 2. owner + permissions mirrored with the service gateway (the new owner may
   *    differ from the caller),
   * 3. the chunks' `space_id` (no re-embedding; no chunks = no-op).
   */
  private async moveOne(caller: MemberPrincipal, docId: number, targetSpaceId: number): Promise<MoveResult> {
    if (!(await this.policy.canAccessDocument(caller, docId, "read"))) {
      throw new MoveRefused("not_found", "Dokument nicht gefunden");
    }
    const home = await this.db
      .select({ spaceId: documentSpaces.spaceId })
      .from(documentSpaces)
      .where(eq(documentSpaces.paperlessDocId, docId))
      .limit(1);
    const sourceSpaceId = home[0]?.spaceId;
    if (sourceSpaceId === undefined) {
      // Unassigned documents are readable by the household admin only — tell
      // a missing id apart from one that is still being processed.
      try {
        await this.gatewayProvider.service().getDocument(docId);
      } catch (error: unknown) {
        if (error instanceof PaperlessNotFoundError) throw new MoveRefused("not_found", "Dokument nicht gefunden");
        throw error;
      }
      throw new MoveRefused("failed", "Dokument hat noch keine Akte (wird noch verarbeitet)");
    }
    if (sourceSpaceId === targetSpaceId) return { doc_id: docId, status: "unchanged" };
    if (!(await this.policy.canAccessDocument(caller, docId, "move"))) {
      throw new MoveRefused("forbidden", "Nur der Eigentümer der Akte kann Dokumente herausverschieben");
    }

    const moved = await this.db
      .update(documentSpaces)
      .set({ spaceId: targetSpaceId })
      .where(and(eq(documentSpaces.paperlessDocId, docId), eq(documentSpaces.spaceId, sourceSpaceId)))
      .returning({ docId: documentSpaces.paperlessDocId });
    if (moved.length === 0) throw new MoveRefused("failed", "Dokument wurde gleichzeitig verschoben");

    const service = this.gatewayProvider.service();
    let qdrantTouched = false;
    try {
      await mirrorDocument(this.db, service, docId);
      if (this.vectorStore !== null) {
        qdrantTouched = true;
        // Shares survive a move: the recipients stay in `shared_with`.
        const { sharedWith } = await this.tenancy.qdrantSpaceFor(docId);
        await this.vectorStore.setSpaceByDocId(docId, { spaceId: targetSpaceId, sharedWith });
      }
    } catch (error: unknown) {
      await this.compensateMove(docId, sourceSpaceId, targetSpaceId, qdrantTouched);
      if (error instanceof PaperlessNotFoundError) throw new MoveRefused("not_found", "Dokument nicht gefunden");
      logger.error("space_move_failed", { doc_id: docId, from: sourceSpaceId, to: targetSpaceId, error: errorText(error) });
      throw new BadGatewayException("Verschieben fehlgeschlagen; das Dokument bleibt in seiner Akte");
    }
    logger.info("document_moved", { doc_id: docId, from: sourceSpaceId, to: targetSpaceId, member_id: caller.memberId });
    return { doc_id: docId, status: "moved" };
  }

  private async compensateMove(docId: number, sourceSpaceId: number, targetSpaceId: number, qdrantTouched: boolean): Promise<void> {
    await this.db
      .update(documentSpaces)
      .set({ spaceId: sourceSpaceId })
      .where(and(eq(documentSpaces.paperlessDocId, docId), eq(documentSpaces.spaceId, targetSpaceId)));
    try {
      await mirrorDocument(this.db, this.gatewayProvider.service(), docId);
      if (qdrantTouched && this.vectorStore !== null) {
        const { sharedWith } = await this.tenancy.qdrantSpaceFor(docId);
        await this.vectorStore.setSpaceByDocId(docId, { spaceId: sourceSpaceId, sharedWith });
      }
    } catch (error: unknown) {
      // The worker's startup reconcile re-sets stale chunk spaces; Paperless
      // permissions are re-mirrored on the document's next assignment.
      logger.error("space_move_compensation_failed", { doc_id: docId, space_id: sourceSpaceId, error: errorText(error) });
    }
  }

  // ------------------------------------------------------------------ helpers

  private async assertPlaceable(caller: MemberPrincipal, spaceId: number): Promise<void> {
    const { role } = await this.roleIn(caller.memberId, spaceId);
    if (role === "viewer") throw new ForbiddenException("In diese Akte dürfen nur Eigentümer und Bearbeiter ablegen");
  }

  private async ownSharedSpace(caller: MemberPrincipal, spaceId: number): Promise<void> {
    const { role, kind } = await this.roleIn(caller.memberId, spaceId);
    if (kind === "personal") throw new ConflictException("Persönliche Akten lassen sich nicht ändern");
    if (role !== "owner") throw new ForbiddenException("Nur der Eigentümer verwaltet diese Akte");
  }

  private async membership(spaceId: number, memberId: number): Promise<SpaceRole> {
    const rows = await this.db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId)))
      .limit(1);
    if (rows[0] === undefined) throw new NotFoundException(`Member ${memberId} is not in space ${spaceId}`);
    return rows[0].role;
  }

  private async householdMember(memberId: number): Promise<DirectoryEntry> {
    const rows = await this.db
      .select({ id: members.id, username: users.username })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.id, memberId), notRemoved(members.id)))
      .limit(1);
    if (rows[0] === undefined) throw new NotFoundException(`Member ${memberId} not found`);
    return rows[0];
  }

  /** Shared-space names are unique among the shared spaces the member belongs to. */
  private async assertNameFree(memberId: number, name: string, exceptSpaceId: number | null): Promise<void> {
    const conditions = [
      eq(spaceMembers.memberId, memberId),
      eq(spaces.kind, "shared"),
      eq(spaces.name, name),
    ];
    if (exceptSpaceId !== null) conditions.push(ne(spaces.id, exceptSpaceId));
    const clash = await this.db
      .select({ id: spaces.id })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(...conditions))
      .limit(1);
    if (clash.length > 0) throw new ConflictException("Eine Akte mit diesem Namen gibt es schon");
  }

  /**
   * Syncs Paperless groups after a membership write; on failure runs `undo`
   * (best effort) and answers 502 so DB and Paperless don't disagree.
   */
  private async applyMembership(spaceId: number, memberId: number, undo: () => Promise<void>): Promise<void> {
    try {
      await syncSpaceMembership(this.db, this.gatewayProvider.service(), spaceId);
    } catch (error: unknown) {
      logger.error("space_membership_paperless_failed", { space_id: spaceId, member_id: memberId, error: errorText(error) });
      try {
        await undo();
      } catch (inner: unknown) {
        logger.error("space_membership_undo_failed", { space_id: spaceId, member_id: memberId, error: errorText(inner) });
      }
      throw new BadGatewayException("Paperless hat die Änderung abgelehnt; die Mitgliedschaft bleibt unverändert");
    }
    this.gateways.forget(memberId);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
