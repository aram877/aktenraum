import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import {
  documentSpaces,
  members,
  spaceMembers,
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
