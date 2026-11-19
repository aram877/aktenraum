import { logger } from "@aktenraum/core";
import { asc, eq } from "drizzle-orm";

import type { Database } from "../db/db.module.js";
import { households, members, spaceMembers, spaces, users } from "../db/schema.js";

/** Name of the household created for an install that has none yet. */
export const DEFAULT_HOUSEHOLD_NAME = "Haushalt";
/** Name of every member's personal space ("Akte"). */
export const PERSONAL_SPACE_NAME = "Persönlich";

export interface TenancyReconcileReport {
  householdId: number;
  householdCreated: boolean;
  membersCreated: number;
  personalSpacesCreated: number;
  spaceOwnersRepaired: number;
}

/**
 * Brings the tenancy tables in line with `users` (ADR-009, tenancy-foundation §1):
 * one household, one member per user — the first user (lowest id) is the
 * household admin when no admin exists yet, every later one a plain member —
 * and one personal space per member, owned by it.
 *
 * Every step only fills gaps, so the function is safe to run on every start and
 * resumes cleanly after a crash halfway through. It never deletes or demotes.
 * The migration CLI (§6) runs the same function as its first step.
 */
export async function reconcileTenancy(
  db: Database,
  options: { dryRun?: boolean } = {},
): Promise<TenancyReconcileReport> {
  const dryRun = options.dryRun === true;
  const report: TenancyReconcileReport = {
    householdId: 0,
    householdCreated: false,
    membersCreated: 0,
    personalSpacesCreated: 0,
    spaceOwnersRepaired: 0,
  };

  const existingHousehold = await db
    .select({ id: households.id })
    .from(households)
    .orderBy(asc(households.id))
    .limit(1);
  let householdId = existingHousehold[0]?.id;
  if (householdId === undefined && dryRun) {
    householdId = -1;
    report.householdCreated = true;
  } else if (householdId === undefined) {
    const inserted = await db
      .insert(households)
      .values({ name: DEFAULT_HOUSEHOLD_NAME })
      .returning({ id: households.id });
    householdId = (inserted[0] as { id: number }).id;
    report.householdCreated = true;
  }
  report.householdId = householdId;

  const allUsers = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.id));
  // One household per install (ADR-009): every member counts, whatever its
  // household_id, so a user is never given a second member row.
  const existingMembers = await db
    .select({ id: members.id, userId: members.userId, role: members.role })
    .from(members);
  const memberByUser = new Map(existingMembers.map((m) => [m.userId, m.id]));
  let hasAdmin = existingMembers.some((m) => m.role === "admin");

  for (const user of allUsers) {
    if (memberByUser.has(user.id)) continue;
    const role = hasAdmin ? "member" : "admin";
    if (dryRun) {
      memberByUser.set(user.id, -user.id);
      hasAdmin = true;
      report.membersCreated += 1;
      continue;
    }
    const inserted = await db
      .insert(members)
      .values({ householdId, userId: user.id, role })
      .returning({ id: members.id });
    memberByUser.set(user.id, (inserted[0] as { id: number }).id);
    hasAdmin = true;
    report.membersCreated += 1;
  }

  const personalSpaces = await db
    .select({ id: spaces.id, memberId: spaces.personalMemberId })
    .from(spaces)
    .where(eq(spaces.kind, "personal"));
  const spaceByMember = new Map(personalSpaces.map((s) => [s.memberId, s.id]));
  const owners = await db
    .select({ spaceId: spaceMembers.spaceId, memberId: spaceMembers.memberId })
    .from(spaceMembers)
    .where(eq(spaceMembers.role, "owner"));
  const ownerKeys = new Set(owners.map((o) => `${o.spaceId}:${o.memberId}`));

  for (const memberId of memberByUser.values()) {
    let spaceId = spaceByMember.get(memberId);
    if (spaceId === undefined && dryRun) {
      report.personalSpacesCreated += 1;
      continue;
    }
    if (spaceId === undefined) {
      const inserted = await db
        .insert(spaces)
        .values({ householdId, name: PERSONAL_SPACE_NAME, kind: "personal", personalMemberId: memberId })
        .returning({ id: spaces.id });
      spaceId = (inserted[0] as { id: number }).id;
      report.personalSpacesCreated += 1;
    }
    if (!ownerKeys.has(`${spaceId}:${memberId}`)) {
      if (!dryRun) await db.insert(spaceMembers).values({ spaceId, memberId, role: "owner" });
      // A brand-new space always needs its owner row; only count real repairs.
      if (spaceByMember.has(memberId)) report.spaceOwnersRepaired += 1;
    }
  }

  return report;
}

export function logTenancyReport(report: TenancyReconcileReport): void {
  const changed =
    report.householdCreated ||
    report.membersCreated > 0 ||
    report.personalSpacesCreated > 0 ||
    report.spaceOwnersRepaired > 0;
  logger.info(changed ? "tenancy_reconciled" : "tenancy_reconcile_noop", { ...report });
}
