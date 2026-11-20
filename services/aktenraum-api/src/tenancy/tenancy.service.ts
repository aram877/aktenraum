import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { SearchAccess } from "@aktenraum/core";
import { logger } from "@aktenraum/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import {
  documentShares,
  documentSpaces,
  memberRemovals,
  members,
  shareAudit,
  spaceMembers,
  spaces,
  users,
  type HouseholdRoleValue,
  type ShareAccessKindValue,
  type ShareRole,
  type SpaceRole,
} from "../db/schema.js";
import { logTenancyReport, reconcileTenancy, type TenancyReconcileReport } from "./reconcile.js";
import { shareActive } from "./share-active.js";

/** `findMember`'s answer for a removed member (tenancy-member-removal). */
const REMOVED = Symbol("removed");

export interface MemberRecord {
  id: number;
  userId: number;
  householdId: number;
  role: HouseholdRoleValue;
}

/**
 * Where a document lives, from one member's point of view: the member's role
 * in its home space and the member's active share on it (either may be null).
 */
export type DocumentSpaceAccess =
  | { assigned: false }
  | { assigned: true; spaceId: number; role: SpaceRole | null; share: ShareRole | null };

export { shareActive };

/** An active share as the rest of the api sees it. */
export interface ActiveShare {
  docId: number;
  memberId: number;
  role: ShareRole;
  expiresAt: string | null;
  grantedBy: number;
}

/** "Geteilt von …" on a recipient's library row / detail header. */
export interface SharedBy {
  username: string;
  role: ShareRole;
  expires_at: string | null;
}

const activeShareColumns = {
  docId: documentShares.paperlessDocId,
  memberId: documentShares.memberId,
  role: documentShares.role,
  expiresAt: documentShares.expiresAt,
  grantedBy: documentShares.grantedBy,
};

/** The tenancy lookups `PolicyService` needs; a fake implements it in unit tests. */
export interface TenancyLookup {
  documentAccess(docId: number, memberId: number): Promise<DocumentSpaceAccess>;
  recordShareAccess?(docId: number, memberId: number, kind: ShareAccessKindValue): Promise<void>;
}

@Injectable()
export class TenancyService implements OnApplicationBootstrap, TenancyLookup {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Runs after every module's `onModuleInit`, so the bootstrap user that
   * `AuthService` may have just created already exists.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<TenancyReconcileReport> {
    const report = await reconcileTenancy(this.db);
    logTenancyReport(report);
    return report;
  }

  /**
   * The member behind a `users.id`. A user created after startup has no member
   * yet; the reconcile runs once on demand instead of failing the request.
   */
  async resolveMember(userId: number): Promise<MemberRecord | null> {
    const found = await this.findMember(userId);
    // A removed member is never a member again; no reconcile can change that.
    if (found === REMOVED) return null;
    if (found !== null) return found;
    await this.reconcile();
    const again = await this.findMember(userId);
    return again === REMOVED ? null : again;
  }

  /** Whether the user behind `users.id` belongs to a removed member (login check). */
  async isUserRemoved(userId: number): Promise<boolean> {
    return (await this.findMember(userId)) === REMOVED;
  }

  async documentAccess(docId: number, memberId: number): Promise<DocumentSpaceAccess> {
    const home = await this.db
      .select({ spaceId: documentSpaces.spaceId })
      .from(documentSpaces)
      .where(eq(documentSpaces.paperlessDocId, docId))
      .limit(1);
    const spaceId = home[0]?.spaceId;
    if (spaceId === undefined) return { assigned: false };
    const membership = await this.db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.memberId, memberId)))
      .limit(1);
    const share = await this.db
      .select({ role: documentShares.role })
      .from(documentShares)
      .where(and(eq(documentShares.paperlessDocId, docId), eq(documentShares.memberId, memberId), shareActive))
      .limit(1);
    return { assigned: true, spaceId, role: membership[0]?.role ?? null, share: share[0]?.role ?? null };
  }

  /**
   * Audit a recipient's access to a shared document: at most one entry per
   * document, member and kind per hour (checked in SQL; two concurrent first
   * accesses may both land, which is harmless). Best effort — a failure is
   * logged and never fails the request.
   */
  async recordShareAccess(docId: number, memberId: number, kind: ShareAccessKindValue): Promise<void> {
    try {
      const recent = await this.db
        .select({ id: shareAudit.id })
        .from(shareAudit)
        .where(
          and(
            eq(shareAudit.paperlessDocId, docId),
            eq(shareAudit.memberId, memberId),
            eq(shareAudit.event, "accessed"),
            eq(shareAudit.accessKind, kind),
            sql`${shareAudit.at} > now() - interval '1 hour'`,
          ),
        )
        .limit(1);
      if (recent.length > 0) return;
      await this.db.insert(shareAudit).values({
        paperlessDocId: docId,
        memberId,
        actorMemberId: memberId,
        event: "accessed",
        accessKind: kind,
      });
    } catch (error: unknown) {
      logger.warn("share_audit_failed", {
        doc_id: docId,
        member_id: memberId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Active shares of one document (expired rows count as absent), by member id. */
  async activeSharesOf(docId: number): Promise<ActiveShare[]> {
    return this.db
      .select(activeShareColumns)
      .from(documentShares)
      .where(and(eq(documentShares.paperlessDocId, docId), shareActive))
      .orderBy(asc(documentShares.memberId));
  }

  /** The Qdrant payload space of a document: home space + active recipients (sorted). */
  async qdrantSpaceFor(docId: number): Promise<{ spaceId: number | null; sharedWith: number[] }> {
    const sharedWith = (await this.activeSharesOf(docId)).map((s) => s.memberId);
    return { spaceId: await this.homeSpaceOf(docId), sharedWith };
  }

  /**
   * Active shares the member received, keyed by document (optionally limited
   * to `docIds`) — for library labels and the inbox exclusion. Empty for a
   * household of one.
   */
  async sharesReceivedBy(memberId: number, docIds?: readonly number[]): Promise<Map<number, ActiveShare>> {
    if (docIds !== undefined && docIds.length === 0) return new Map();
    const conditions = [eq(documentShares.memberId, memberId), shareActive];
    if (docIds !== undefined) conditions.push(inArray(documentShares.paperlessDocId, [...docIds]));
    const rows = await this.db.select(activeShareColumns).from(documentShares).where(and(...conditions));
    return new Map(rows.map((r) => [r.docId, r]));
  }

  async homeSpaceOf(docId: number): Promise<number | null> {
    const rows = await this.db
      .select({ spaceId: documentSpaces.spaceId })
      .from(documentSpaces)
      .where(eq(documentSpaces.paperlessDocId, docId))
      .limit(1);
    return rows[0]?.spaceId ?? null;
  }

  /** Name, kind and owning member's username of a document's home space, for display. */
  async homeSpaceSummary(docId: number): Promise<{
    id: number;
    name: string;
    kind: "personal" | "shared";
    owner: string | null;
  } | null> {
    const rows = await this.db
      .select({
        id: spaces.id,
        name: spaces.name,
        kind: spaces.kind,
        personalMemberId: spaces.personalMemberId,
      })
      .from(documentSpaces)
      .innerJoin(spaces, eq(spaces.id, documentSpaces.spaceId))
      .where(eq(documentSpaces.paperlessDocId, docId))
      .limit(1);
    const space = rows[0];
    if (space === undefined) return null;
    let ownerMemberId = space.personalMemberId;
    if (ownerMemberId === null) {
      const owners = await this.db
        .select({ memberId: spaceMembers.memberId })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.role, "owner")))
        .orderBy(asc(spaceMembers.memberId))
        .limit(1);
      ownerMemberId = owners[0]?.memberId ?? null;
    }
    let owner: string | null = null;
    if (ownerMemberId !== null) {
      const found = await this.db
        .select({ username: users.username })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(eq(members.id, ownerMemberId))
        .limit(1);
      owner = found[0]?.username ?? null;
    }
    return { id: space.id, name: space.name, kind: space.kind, owner };
  }

  /** Home space (id, name, kind) per document, one query for a whole page. */
  async homeSpacesOf(
    docIds: readonly number[],
  ): Promise<Map<number, { id: number; name: string; kind: "personal" | "shared" }>> {
    if (docIds.length === 0) return new Map();
    const rows = await this.db
      .select({ docId: documentSpaces.paperlessDocId, id: spaces.id, name: spaces.name, kind: spaces.kind })
      .from(documentSpaces)
      .innerJoin(spaces, eq(spaces.id, documentSpaces.spaceId))
      .where(inArray(documentSpaces.paperlessDocId, [...docIds]));
    return new Map(rows.map((r) => [r.docId, { id: r.id, name: r.name, kind: r.kind }]));
  }

  async spaceDocumentIds(spaceId: number): Promise<number[]> {
    const rows = await this.db
      .select({ docId: documentSpaces.paperlessDocId })
      .from(documentSpaces)
      .where(eq(documentSpaces.spaceId, spaceId));
    return rows.map((r) => r.docId).sort((a, b) => a - b);
  }

  /**
   * Documents kept out of the member's review inbox (ADR-009): those of spaces
   * where the member is only a viewer, and those shared with the member that
   * are not in one of the member's spaces. Empty for most members (and always
   * for a household of one), which lets callers skip the extra work.
   */
  async notReviewableDocumentIds(memberId: number): Promise<Set<number>> {
    const rows = await this.db
      .select({ docId: documentSpaces.paperlessDocId })
      .from(spaceMembers)
      .innerJoin(documentSpaces, eq(documentSpaces.spaceId, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.memberId, memberId), eq(spaceMembers.role, "viewer")));
    const excluded = new Set(rows.map((r) => r.docId));
    const shared = await this.sharesReceivedBy(memberId);
    if (shared.size > 0) {
      const mySpaces = new Set(await this.spaceIdsOf(memberId));
      const homes = await this.homeSpacesOf([...shared.keys()]);
      for (const docId of shared.keys()) {
        const home = homes.get(docId);
        // A space role wins over a share: an editor/owner of the home space still reviews it.
        if (home === undefined || !mySpaces.has(home.id)) excluded.add(docId);
      }
    }
    return excluded;
  }

  /**
   * Library labels for a page of documents: the home space when the member is
   * in it, otherwise `homeSpace: null` and — for a document shared with the
   * member — who shared it. The sharer's space name never reaches the
   * recipient. `memberId` null (worker) = home spaces as they are.
   */
  async documentLabels(
    memberId: number | null,
    docIds: readonly number[],
  ): Promise<Map<number, { homeSpace: { id: number; name: string; kind: "personal" | "shared" } | null; sharedBy: SharedBy | null }>> {
    const homes = await this.homeSpacesOf(docIds);
    const out = new Map<number, { homeSpace: { id: number; name: string; kind: "personal" | "shared" } | null; sharedBy: SharedBy | null }>();
    if (memberId === null) {
      for (const id of docIds) out.set(id, { homeSpace: homes.get(id) ?? null, sharedBy: null });
      return out;
    }
    const mine = new Set(await this.spaceIdsOf(memberId));
    const outside = docIds.filter((id) => {
      const home = homes.get(id);
      return home !== undefined && !mine.has(home.id);
    });
    const shares = await this.sharesReceivedBy(memberId, outside);
    const names = await this.usernamesOf([...shares.values()].map((s) => s.grantedBy));
    for (const id of docIds) {
      const home = homes.get(id);
      if (home === undefined || mine.has(home.id)) {
        out.set(id, { homeSpace: home ?? null, sharedBy: null });
        continue;
      }
      const share = shares.get(id);
      out.set(id, {
        homeSpace: null,
        sharedBy:
          share === undefined
            ? null
            : { username: names.get(share.grantedBy) ?? "", role: share.role, expires_at: share.expiresAt },
      });
    }
    return out;
  }

  /** aktenraum usernames per member id. */
  async usernamesOf(memberIds: readonly number[]): Promise<Map<number, string>> {
    if (memberIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: members.id, username: users.username })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(inArray(members.id, [...new Set(memberIds)]));
    return new Map(rows.map((r) => [r.id, r.username]));
  }

  /** Spaces the member belongs to (any role). */
  async spaceIdsOf(memberId: number): Promise<number[]> {
    const rows = await this.db
      .select({ spaceId: spaceMembers.spaceId })
      .from(spaceMembers)
      .where(eq(spaceMembers.memberId, memberId));
    return rows.map((r) => r.spaceId).sort((a, b) => a - b);
  }

  /**
   * What a member may retrieve from the vector index: chunks of its spaces,
   * chunks shared with it, and — household admin only — chunks of documents
   * without a home space yet (same rule as `PolicyService`).
   */
  async searchAccess(member: { memberId: number; householdRole: HouseholdRoleValue }): Promise<SearchAccess> {
    return {
      spaceIds: await this.spaceIdsOf(member.memberId),
      memberId: member.memberId,
      includeUnassigned: member.householdRole === "admin",
    };
  }

  /**
   * Which of `docIds` live in the same home space as `docId` — for corpus
   * features (duplicates) that must not compare across spaces. A document
   * without a home space is compared only with other unassigned ones.
   */
  async sameSpaceAs(docId: number, docIds: readonly number[]): Promise<Set<number>> {
    if (docIds.length === 0) return new Set();
    const home = await this.homeSpaceOf(docId);
    const rows = await this.db
      .select({ docId: documentSpaces.paperlessDocId, spaceId: documentSpaces.spaceId })
      .from(documentSpaces)
      .where(inArray(documentSpaces.paperlessDocId, [...docIds]));
    const spaceByDoc = new Map(rows.map((r) => [r.docId, r.spaceId]));
    return new Set(docIds.filter((id) => (spaceByDoc.get(id) ?? null) === home));
  }

  private async findMember(userId: number): Promise<MemberRecord | typeof REMOVED | null> {
    const rows = await this.db
      .select({
        id: members.id,
        userId: members.userId,
        householdId: members.householdId,
        role: members.role,
        removedId: memberRemovals.memberId,
      })
      .from(members)
      .leftJoin(memberRemovals, eq(memberRemovals.memberId, members.id))
      .where(eq(members.userId, userId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.removedId !== null) return REMOVED;
    return { id: row.id, userId: row.userId, householdId: row.householdId, role: row.role };
  }
}
