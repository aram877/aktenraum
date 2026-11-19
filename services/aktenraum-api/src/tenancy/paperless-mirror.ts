import { randomBytes } from "node:crypto";

import { logger } from "@aktenraum/core";
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "../db/db.module.js";
import { documentSpaces, members, spaceMembers, spaces } from "../db/schema.js";
import type {
  DocumentPermissions,
  ObjectPermissions,
  PaperlessGateway,
} from "../paperless/paperless.gateway.js";

/**
 * Paperless mirror of the tenancy model (ADR-009 §Paperless enforces too):
 * one Paperless user per member, one group per space, and for every document
 * owner = the Paperless user of the space's owning member plus view+change for
 * the space group. aktenraum's tables are the source of truth; these functions
 * only bring Paperless in line and are idempotent.
 */

/** The gateway methods the mirror uses — the test fake implements exactly these. */
export type PaperlessTenancyPort = Pick<
  PaperlessGateway,
  | "findUserByUsername"
  | "getUser"
  | "createUser"
  | "updateUser"
  | "findGroupByName"
  | "createGroup"
  | "getDocumentPermissions"
  | "setDocumentPermissions"
  | "bulkSetDocumentPermissions"
>;

/**
 * What a member's Paperless user may do — the set the 2026-11-19 spike
 * verified (non-superuser; object permissions decide which documents).
 */
export const PAPERLESS_MEMBER_PERMISSIONS: readonly string[] = [
  "view_document",
  "add_document",
  "change_document",
  "delete_document",
  "view_tag",
  "add_tag",
  "change_tag",
  "view_correspondent",
  "add_correspondent",
  "view_documenttype",
  "add_documenttype",
  "view_customfield",
  "view_note",
  "add_note",
  "view_paperlesstask",
  "view_uisettings",
  "change_uisettings",
  "add_uisettings",
];

export function memberUsername(memberId: number): string {
  return `ak-${memberId}`;
}

export function spaceGroupName(spaceId: number): string {
  return `space-${spaceId}`;
}

function sameSet(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function samePermissions(a: DocumentPermissions, b: DocumentPermissions): boolean {
  const eqPart = (x: ObjectPermissions, y: ObjectPermissions) =>
    sameSet(x.view.users, y.view.users) &&
    sameSet(x.view.groups, y.view.groups) &&
    sameSet(x.change.users, y.change.users) &&
    sameSet(x.change.groups, y.change.groups);
  return a.owner === b.owner && eqPart(a.permissions, b.permissions);
}

export type ProvisionOutcome = "existing" | "linked" | "created";

/**
 * Ensures the member's Paperless user exists, is linked in `members` and has
 * the member permission set. The password is random and never stored —
 * aktenraum will mint tokens through the admin API when it needs them.
 */
export async function provisionMemberUser(
  db: Database,
  paperless: PaperlessTenancyPort,
  memberId: number,
): Promise<{ paperlessUserId: number; outcome: ProvisionOutcome }> {
  const rows = await db
    .select({ paperlessUserId: members.paperlessUserId })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`member ${memberId} does not exist`);

  let outcome: ProvisionOutcome = "existing";
  let user =
    row.paperlessUserId !== null
      ? await paperless.getUser(row.paperlessUserId)
      : await paperless.findUserByUsername(memberUsername(memberId));
  if (user === null) {
    user = await paperless.createUser({
      username: memberUsername(memberId),
      password: randomBytes(32).toString("base64url"),
      permissions: PAPERLESS_MEMBER_PERMISSIONS,
    });
    outcome = "created";
  } else if (row.paperlessUserId === null) {
    outcome = "linked";
  }
  if (row.paperlessUserId !== user.id) {
    await db.update(members).set({ paperlessUserId: user.id }).where(eq(members.id, memberId));
  }
  if (outcome !== "created" && !sameSet(user.user_permissions ?? [], PAPERLESS_MEMBER_PERMISSIONS)) {
    await paperless.updateUser(user.id, { user_permissions: PAPERLESS_MEMBER_PERMISSIONS });
    logger.info("tenancy_paperless_user_permissions_reset", { member_id: memberId, user_id: user.id });
  }
  return { paperlessUserId: user.id, outcome };
}

/**
 * Ensures the space's Paperless group exists and is linked, and that every
 * `owner`/`editor` of the space is in it (group = view + change). Viewers get
 * per-user view permissions once shared spaces exist (tenancy-sharing).
 */
export async function provisionSpaceGroup(
  db: Database,
  paperless: PaperlessTenancyPort,
  spaceId: number,
): Promise<{ paperlessGroupId: number; outcome: ProvisionOutcome; membersAdded: number }> {
  const rows = await db
    .select({ paperlessGroupId: spaces.paperlessGroupId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`space ${spaceId} does not exist`);

  let outcome: ProvisionOutcome = "existing";
  let groupId = row.paperlessGroupId;
  if (groupId === null) {
    const found = await paperless.findGroupByName(spaceGroupName(spaceId));
    if (found !== null) {
      groupId = found.id;
      outcome = "linked";
    } else {
      groupId = (await paperless.createGroup(spaceGroupName(spaceId))).id;
      outcome = "created";
    }
    await db.update(spaces).set({ paperlessGroupId: groupId }).where(eq(spaces.id, spaceId));
  }

  const writers = await db
    .select({ memberId: spaceMembers.memberId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(asc(spaceMembers.memberId));
  let membersAdded = 0;
  for (const writer of writers) {
    if (writer.role === "viewer") continue;
    const { paperlessUserId } = await provisionMemberUser(db, paperless, writer.memberId);
    const user = await paperless.getUser(paperlessUserId);
    const groups = user.groups ?? [];
    if (!groups.includes(groupId)) {
      await paperless.updateUser(paperlessUserId, { groups: [...groups, groupId] });
      membersAdded += 1;
    }
  }
  return { paperlessGroupId: groupId, outcome, membersAdded };
}

/**
 * Target Paperless owner + permissions for documents of a space: the owner is
 * the personal member (personal space) or the space's first owner (shared),
 * and the space group may view and change. Provisions user and group on the way.
 */
export async function spaceDocumentPermissions(
  db: Database,
  paperless: PaperlessTenancyPort,
  spaceId: number,
): Promise<DocumentPermissions> {
  const { paperlessGroupId } = await provisionSpaceGroup(db, paperless, spaceId);
  const space = (
    await db
      .select({ personalMemberId: spaces.personalMemberId })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1)
  )[0];
  let ownerMemberId = space?.personalMemberId ?? null;
  if (ownerMemberId === null) {
    const owners = await db
      .select({ memberId: spaceMembers.memberId })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, "owner")))
      .orderBy(asc(spaceMembers.memberId))
      .limit(1);
    ownerMemberId = owners[0]?.memberId ?? null;
  }
  if (ownerMemberId === null) throw new Error(`space ${spaceId} has no owner`);
  const { paperlessUserId } = await provisionMemberUser(db, paperless, ownerMemberId);
  return {
    owner: paperlessUserId,
    permissions: {
      view: { users: [], groups: [paperlessGroupId] },
      change: { users: [], groups: [paperlessGroupId] },
    },
  };
}

export type MirrorOutcome = "unchanged" | "updated" | "unassigned";

/** Brings one document's Paperless owner + permissions in line with its home space. */
export async function mirrorDocument(
  db: Database,
  paperless: PaperlessTenancyPort,
  docId: number,
): Promise<MirrorOutcome> {
  const home = await db
    .select({ spaceId: documentSpaces.spaceId })
    .from(documentSpaces)
    .where(eq(documentSpaces.paperlessDocId, docId))
    .limit(1);
  const spaceId = home[0]?.spaceId;
  if (spaceId === undefined) return "unassigned";
  const target = await spaceDocumentPermissions(db, paperless, spaceId);
  const current = await paperless.getDocumentPermissions(docId);
  if (samePermissions(current, target)) return "unchanged";
  await paperless.setDocumentPermissions(docId, target);
  return "updated";
}
