import { randomBytes } from "node:crypto";

import { logger } from "@aktenraum/core";
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "../db/db.module.js";
import {
  documentShares,
  documentSpaces,
  members,
  spaceMembers,
  spacePaperlessGroups,
  spaces,
} from "../db/schema.js";
import { shareActive } from "./share-active.js";
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
  | "deactivateUser"
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

/** View-only group of a shared space, holding its viewers. */
export function spaceViewerGroupName(spaceId: number): string {
  return `space-${spaceId}-view`;
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
 * Ensures the space's Paperless (writer) group exists and is linked, and that
 * every `owner`/`editor` of the space is in it (group = view + change). It only
 * ever adds; `syncSpaceMembership` is the full diff, viewers included.
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
      .select({ personalMemberId: spaces.personalMemberId, kind: spaces.kind })
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
  // Personal spaces keep exactly the pre-shared-spaces target, so every
  // existing document mirrors as `unchanged`.
  const viewerGroupId =
    space?.kind === "shared" ? await provisionViewerGroup(db, paperless, spaceId) : null;
  return {
    owner: paperlessUserId,
    permissions: {
      view: {
        users: [],
        groups: viewerGroupId === null ? [paperlessGroupId] : [paperlessGroupId, viewerGroupId],
      },
      change: { users: [], groups: [paperlessGroupId] },
    },
  };
}

/**
 * Paperless user ids of a document's active share recipients
 * (tenancy-document-shares): every recipient may view, editors may also
 * change. Provisions recipients' Paperless users on the way. Expired rows are
 * left out, so the expiry sweep's re-mirror drops them.
 */
export async function shareUserGrants(
  db: Database,
  paperless: PaperlessTenancyPort,
  docId: number,
): Promise<{ view: number[]; change: number[] }> {
  const rows = await db
    .select({ memberId: documentShares.memberId, role: documentShares.role })
    .from(documentShares)
    .where(and(eq(documentShares.paperlessDocId, docId), shareActive))
    .orderBy(asc(documentShares.memberId));
  const view: number[] = [];
  const change: number[] = [];
  for (const row of rows) {
    const { paperlessUserId } = await provisionMemberUser(db, paperless, row.memberId);
    view.push(paperlessUserId);
    if (row.role === "editor") change.push(paperlessUserId);
  }
  const byId = (a: number, b: number) => a - b;
  return { view: view.sort(byId), change: change.sort(byId) };
}

/** The space target plus share users; no shares = exactly the space target. */
export function withShareUsers(
  target: DocumentPermissions,
  shares: { view: number[]; change: number[] },
): DocumentPermissions {
  return {
    owner: target.owner,
    permissions: {
      view: { users: shares.view, groups: target.permissions.view.groups },
      change: { users: shares.change, groups: target.permissions.change.groups },
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
  const target = withShareUsers(
    await spaceDocumentPermissions(db, paperless, spaceId),
    await shareUserGrants(db, paperless, docId),
  );
  const current = await paperless.getDocumentPermissions(docId);
  if (samePermissions(current, target)) return "unchanged";
  await paperless.setDocumentPermissions(docId, target);
  return "updated";
}

/**
 * Ensures the viewer group `space-<id>-view` of a shared space exists and is
 * recorded in `space_paperless_groups`. Returns its id.
 */
export async function provisionViewerGroup(
  db: Database,
  paperless: PaperlessTenancyPort,
  spaceId: number,
): Promise<number> {
  const stored = async () =>
    (
      await db
        .select({ viewerGroupId: spacePaperlessGroups.viewerGroupId })
        .from(spacePaperlessGroups)
        .where(eq(spacePaperlessGroups.spaceId, spaceId))
        .limit(1)
    )[0]?.viewerGroupId;
  const known = await stored();
  if (known !== undefined) return known;
  const name = spaceViewerGroupName(spaceId);
  const groupId = (await paperless.findGroupByName(name))?.id ?? (await paperless.createGroup(name)).id;
  await db.insert(spacePaperlessGroups).values({ spaceId, viewerGroupId: groupId }).onConflictDoNothing();
  return (await stored()) ?? groupId;
}

/** A space's Paperless group ids (viewer = null for a personal space), provisioning them. */
export async function spaceGroupIds(
  db: Database,
  paperless: PaperlessTenancyPort,
  spaceId: number,
): Promise<{ writer: number; viewer: number | null }> {
  const { paperlessGroupId } = await provisionSpaceGroup(db, paperless, spaceId);
  const space = (
    await db.select({ kind: spaces.kind }).from(spaces).where(eq(spaces.id, spaceId)).limit(1)
  )[0];
  const viewer = space?.kind === "shared" ? await provisionViewerGroup(db, paperless, spaceId) : null;
  return { writer: paperlessGroupId, viewer };
}

async function setUserGroups(
  paperless: PaperlessTenancyPort,
  paperlessUserId: number,
  change: (groups: readonly number[]) => number[],
): Promise<boolean> {
  const user = await paperless.getUser(paperlessUserId);
  const current = user.groups ?? [];
  const next = change(current);
  if (sameSet(current, next)) return false;
  await paperless.updateUser(paperlessUserId, { groups: next });
  return true;
}

/**
 * Brings Paperless group membership in line with `space_members` for one
 * space: owner + editors in the writer group (and out of the viewer group),
 * viewers in the viewer group (and out of the writer group). A Paperless user
 * is PATCHed only when its group set differs, so a re-run writes nothing.
 * Members who are no longer in the space go through `removeFromSpaceGroups`.
 */
export async function syncSpaceMembership(
  db: Database,
  paperless: PaperlessTenancyPort,
  spaceId: number,
): Promise<{ writerGroupId: number; viewerGroupId: number | null; usersUpdated: number }> {
  const groups = await spaceGroupIds(db, paperless, spaceId);
  const rows = await db
    .select({ memberId: spaceMembers.memberId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(asc(spaceMembers.memberId));
  let usersUpdated = 0;
  for (const row of rows) {
    const want = row.role === "viewer" ? groups.viewer : groups.writer;
    const drop = row.role === "viewer" ? groups.writer : groups.viewer;
    if (want === null) continue; // a personal space has no viewers
    const { paperlessUserId } = await provisionMemberUser(db, paperless, row.memberId);
    const changed = await setUserGroups(paperless, paperlessUserId, (current) => [
      ...current.filter((g) => g !== drop && g !== want),
      want,
    ]);
    if (changed) usersUpdated += 1;
  }
  return { writerGroupId: groups.writer, viewerGroupId: groups.viewer, usersUpdated };
}

/**
 * Takes a member out of both groups of a space (removed, left, or the space
 * was deleted). Idempotent; a member without a Paperless user is a no-op.
 */
export async function removeFromSpaceGroups(
  db: Database,
  paperless: PaperlessTenancyPort,
  memberId: number,
  spaceId: number,
): Promise<boolean> {
  const member = (
    await db
      .select({ paperlessUserId: members.paperlessUserId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1)
  )[0];
  const paperlessUserId = member?.paperlessUserId ?? null;
  if (paperlessUserId === null) return false;
  const writer = (
    await db.select({ id: spaces.paperlessGroupId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1)
  )[0]?.id;
  const viewer = (
    await db
      .select({ id: spacePaperlessGroups.viewerGroupId })
      .from(spacePaperlessGroups)
      .where(eq(spacePaperlessGroups.spaceId, spaceId))
      .limit(1)
  )[0]?.id;
  const drop = new Set([writer, viewer].filter((g): g is number => typeof g === "number"));
  if (drop.size === 0) return false;
  return setUserGroups(paperless, paperlessUserId, (current) => current.filter((g) => !drop.has(g)));
}
