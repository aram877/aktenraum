import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { SearchAccess } from "@aktenraum/core";
import { and, asc, eq, inArray } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import {
  documentSpaces,
  members,
  spaceMembers,
  spaces,
  users,
  type HouseholdRoleValue,
  type SpaceRole,
} from "../db/schema.js";
import { logTenancyReport, reconcileTenancy, type TenancyReconcileReport } from "./reconcile.js";

export interface MemberRecord {
  id: number;
  userId: number;
  householdId: number;
  role: HouseholdRoleValue;
}

/** Where a document lives, from one member's point of view. */
export type DocumentSpaceAccess =
  | { assigned: false }
  | { assigned: true; spaceId: number; role: SpaceRole | null };

/** The tenancy lookups `PolicyService` needs; a fake implements it in unit tests. */
export interface TenancyLookup {
  documentAccess(docId: number, memberId: number): Promise<DocumentSpaceAccess>;
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
    if (found !== null) return found;
    await this.reconcile();
    return this.findMember(userId);
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
    return { assigned: true, spaceId, role: membership[0]?.role ?? null };
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
   * Documents in spaces where the member is only a viewer — kept out of their
   * review inbox (ADR-009). Empty for most members (and always for a
   * household of one), which lets callers skip the extra work.
   */
  async viewerDocumentIds(memberId: number): Promise<Set<number>> {
    const rows = await this.db
      .select({ docId: documentSpaces.paperlessDocId })
      .from(spaceMembers)
      .innerJoin(documentSpaces, eq(documentSpaces.spaceId, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.memberId, memberId), eq(spaceMembers.role, "viewer")));
    return new Set(rows.map((r) => r.docId));
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

  private async findMember(userId: number): Promise<MemberRecord | null> {
    const rows = await this.db
      .select({
        id: members.id,
        userId: members.userId,
        householdId: members.householdId,
        role: members.role,
      })
      .from(members)
      .where(eq(members.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }
}
