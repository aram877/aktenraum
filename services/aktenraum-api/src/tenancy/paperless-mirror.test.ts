import { afterEach, describe, expect, it } from "vitest";

import { and, eq, sql } from "drizzle-orm";

import { documentShares, documentSpaces, households, members, spaceMembers, spacePaperlessGroups, spaces, users } from "../db/schema.js";
import { FakeGateway, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import { household } from "../test/household.js";
import {
  PAPERLESS_MEMBER_PERMISSIONS,
  memberUsername,
  mirrorDocument,
  provisionMemberUser,
  provisionSpaceGroup,
  removeFromSpaceGroups,
  spaceGroupName,
  spaceViewerGroupName,
  syncSpaceMembership,
} from "./paperless-mirror.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup() {
  harness = await createHarness({
    env: { BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "correct-horse" },
  });
  const paperless = new FakeGateway({ docs: [makeDoc({ id: 1 }), makeDoc({ id: 2 })] });
  const [member] = await harness.db.select().from(members);
  const [space] = await harness.db.select().from(spaces);
  return { db: harness.db, paperless, memberId: member!.id, spaceId: space!.id };
}

describe("provisionMemberUser", () => {
  it("creates a non-superuser ak-<id> with the spike permission set and links it", async () => {
    const { db, paperless, memberId } = await setup();

    const result = await provisionMemberUser(db, paperless, memberId);

    expect(result.outcome).toBe("created");
    const user = paperless.users.get(result.paperlessUserId)!;
    expect(user.username).toBe(memberUsername(memberId));
    expect(user.is_superuser).toBe(false);
    expect([...user.user_permissions].sort()).toEqual([...PAPERLESS_MEMBER_PERMISSIONS].sort());
    const [row] = await db.select().from(members);
    expect(row!.paperlessUserId).toBe(result.paperlessUserId);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const { db, paperless, memberId } = await setup();
    await provisionMemberUser(db, paperless, memberId);
    const writes = paperless.tenancyWrites.length;

    const again = await provisionMemberUser(db, paperless, memberId);

    expect(again.outcome).toBe("existing");
    expect(paperless.tenancyWrites).toHaveLength(writes);
  });

  it("links an existing Paperless user of the same name instead of creating a second", async () => {
    const { db, paperless, memberId } = await setup();
    const existing = await paperless.createUser({
      username: memberUsername(memberId),
      password: "x",
      permissions: PAPERLESS_MEMBER_PERMISSIONS,
    });

    const result = await provisionMemberUser(db, paperless, memberId);

    expect(result).toEqual({ paperlessUserId: existing.id, outcome: "linked" });
    expect([...paperless.users.values()].filter((u) => u.username === memberUsername(memberId))).toHaveLength(1);
  });

  it("resets drifted permissions", async () => {
    const { db, paperless, memberId } = await setup();
    const { paperlessUserId } = await provisionMemberUser(db, paperless, memberId);
    await paperless.updateUser(paperlessUserId, { user_permissions: ["view_document"] });

    await provisionMemberUser(db, paperless, memberId);

    expect([...paperless.users.get(paperlessUserId)!.user_permissions].sort()).toEqual(
      [...PAPERLESS_MEMBER_PERMISSIONS].sort(),
    );
  });
});

describe("provisionSpaceGroup", () => {
  it("creates space-<id>, links it and puts the owner's user in it — once", async () => {
    const { db, paperless, spaceId } = await setup();

    const first = await provisionSpaceGroup(db, paperless, spaceId);

    expect(first.outcome).toBe("created");
    expect(first.membersAdded).toBe(1);
    expect(paperless.groups.get(first.paperlessGroupId)?.name).toBe(spaceGroupName(spaceId));
    const [space] = await db.select().from(spaces);
    expect(space!.paperlessGroupId).toBe(first.paperlessGroupId);
    const [member] = await db.select().from(members);
    expect(paperless.users.get(member!.paperlessUserId!)!.groups).toEqual([first.paperlessGroupId]);

    const writes = paperless.tenancyWrites.length;
    const second = await provisionSpaceGroup(db, paperless, spaceId);
    expect(second).toEqual({ paperlessGroupId: first.paperlessGroupId, outcome: "existing", membersAdded: 0 });
    expect(paperless.tenancyWrites).toHaveLength(writes);
  });
});

describe("mirrorDocument", () => {
  it("sets owner = member user and view+change for the space group, then is a no-op", async () => {
    const { db, paperless, spaceId } = await setup();
    await db.insert(documentSpaces).values({ paperlessDocId: 1, spaceId });

    expect(await mirrorDocument(db, paperless, 1)).toBe("updated");

    const [member] = await db.select().from(members);
    const [space] = await db.select().from(spaces);
    expect(paperless.permissions.get(1)).toEqual({
      owner: member!.paperlessUserId,
      permissions: {
        view: { users: [], groups: [space!.paperlessGroupId] },
        change: { users: [], groups: [space!.paperlessGroupId] },
      },
    });
    // What the spike verified end to end: the member's own Paperless user lists it.
    expect(paperless.visibleTo(member!.paperlessUserId!)).toEqual([1]);

    const writes = paperless.tenancyWrites.length;
    expect(await mirrorDocument(db, paperless, 1)).toBe("unchanged");
    expect(paperless.tenancyWrites).toHaveLength(writes);
  });

  it("leaves a document without a home space alone", async () => {
    const { db, paperless } = await setup();
    expect(await mirrorDocument(db, paperless, 2)).toBe("unassigned");
    expect(paperless.tenancyWrites).toHaveLength(0);
  });
});

// ------------------------------------------------------------ shared spaces

async function sharedSetup() {
  const base = await setup();
  const { db, paperless } = base;
  const [user] = await db.insert(users).values({ username: "bob", passwordHash: "x" }).returning();
  const [household] = await db.select().from(households);
  const [bob] = await db.insert(members).values({ householdId: household!.id, userId: user!.id, role: "member" }).returning();
  const [carol] = await db
    .insert(members)
    .values({
      householdId: household!.id,
      userId: (await db.insert(users).values({ username: "carol", passwordHash: "x" }).returning())[0]!.id,
      role: "member",
    })
    .returning();
  const [shared] = await db
    .insert(spaces)
    .values({ householdId: household!.id, name: "Haushalt", kind: "shared" })
    .returning();
  await db.insert(spaceMembers).values([
    { spaceId: shared!.id, memberId: base.memberId, role: "owner" },
    { spaceId: shared!.id, memberId: bob!.id, role: "editor" },
    { spaceId: shared!.id, memberId: carol!.id, role: "viewer" },
  ]);
  const userOf = async (memberId: number) =>
    (await db.select().from(members).where(eq(members.id, memberId)))[0]!.paperlessUserId!;
  return { ...base, paperless, sharedId: shared!.id, bobId: bob!.id, carolId: carol!.id, userOf };
}

describe("shared-space mirror", () => {
  it("personal documents keep the single-group target and mirror as unchanged", async () => {
    const { db, paperless, spaceId } = await setup();
    await db.insert(documentSpaces).values({ paperlessDocId: 1, spaceId });
    await mirrorDocument(db, paperless, 1);
    // A shared space appearing elsewhere doesn't change the personal target.
    const [household] = await db.select().from(households);
    await db.insert(spaces).values({ householdId: household!.id, name: "X", kind: "shared" });
    const writes = paperless.tenancyWrites.length;

    expect(await mirrorDocument(db, paperless, 1)).toBe("unchanged");
    expect(paperless.tenancyWrites).toHaveLength(writes);
    expect(paperless.permissions.get(1)!.permissions.view.groups).toHaveLength(1);
  });

  it("shared documents: owner = space owner, view = writer + viewer group, change = writer group", async () => {
    const { db, paperless, sharedId, memberId, userOf } = await sharedSetup();
    await db.insert(documentSpaces).values({ paperlessDocId: 1, spaceId: sharedId });

    expect(await mirrorDocument(db, paperless, 1)).toBe("updated");

    const writer = paperless.groups.get((await db.select().from(spaces).where(eq(spaces.id, sharedId)))[0]!.paperlessGroupId!)!;
    const viewer = [...paperless.groups.values()].find((g) => g.name === spaceViewerGroupName(sharedId))!;
    expect(writer.name).toBe(spaceGroupName(sharedId));
    expect(paperless.permissions.get(1)).toEqual({
      owner: await userOf(memberId),
      permissions: {
        view: { users: [], groups: [writer.id, viewer.id] },
        change: { users: [], groups: [writer.id] },
      },
    });
    const [row] = await db.select().from(spacePaperlessGroups);
    expect(row).toMatchObject({ spaceId: sharedId, viewerGroupId: viewer.id });
    expect(await mirrorDocument(db, paperless, 1)).toBe("unchanged");
  });

  it("syncSpaceMembership puts writers and viewers in their groups, idempotently", async () => {
    const { db, paperless, sharedId, memberId, bobId, carolId, userOf } = await sharedSetup();
    await db.insert(documentSpaces).values({ paperlessDocId: 1, spaceId: sharedId });

    const first = await syncSpaceMembership(db, paperless, sharedId);
    await mirrorDocument(db, paperless, 1);

    const groupsOf = async (m: number) => paperless.users.get(await userOf(m))!.groups;
    expect(await groupsOf(memberId)).toContain(first.writerGroupId);
    expect(await groupsOf(bobId)).toEqual([first.writerGroupId]);
    expect(await groupsOf(carolId)).toEqual([first.viewerGroupId]);
    // Paperless enforces it: all three see the document, only writers may change it.
    for (const m of [memberId, bobId, carolId]) expect(paperless.visibleTo(await userOf(m))).toContain(1);
    expect(paperless.canChange(await userOf(bobId), 1)).toBe(true);
    expect(paperless.canChange(await userOf(carolId), 1)).toBe(false);

    const writes = paperless.tenancyWrites.length;
    expect((await syncSpaceMembership(db, paperless, sharedId)).usersUpdated).toBe(0);
    expect(paperless.tenancyWrites).toHaveLength(writes);
  });

  it("role change editor ↔ viewer swaps the group without touching documents", async () => {
    const { db, paperless, sharedId, bobId, userOf } = await sharedSetup();
    await db.insert(documentSpaces).values({ paperlessDocId: 1, spaceId: sharedId });
    const { writerGroupId, viewerGroupId } = await syncSpaceMembership(db, paperless, sharedId);
    await mirrorDocument(db, paperless, 1);
    const perms = structuredClone(paperless.permissions.get(1));

    await db.update(spaceMembers).set({ role: "viewer" }).where(and(eq(spaceMembers.spaceId, sharedId), eq(spaceMembers.memberId, bobId)));
    expect((await syncSpaceMembership(db, paperless, sharedId)).usersUpdated).toBe(1);
    expect(paperless.users.get(await userOf(bobId))!.groups).toEqual([viewerGroupId]);
    expect(paperless.canChange(await userOf(bobId), 1)).toBe(false);
    expect(paperless.visibleTo(await userOf(bobId))).toContain(1);

    await db.update(spaceMembers).set({ role: "editor" }).where(and(eq(spaceMembers.spaceId, sharedId), eq(spaceMembers.memberId, bobId)));
    await syncSpaceMembership(db, paperless, sharedId);
    expect(paperless.users.get(await userOf(bobId))!.groups).toEqual([writerGroupId]);
    expect(paperless.permissions.get(1)).toEqual(perms);
    expect(paperless.tenancyWrites.filter((w) => w.op === "setDocumentPermissions" && w.target === 1)).toHaveLength(1);
  });

  it("removeFromSpaceGroups revokes access at once and is idempotent", async () => {
    const { db, paperless, sharedId, carolId, userOf } = await sharedSetup();
    await db.insert(documentSpaces).values({ paperlessDocId: 1, spaceId: sharedId });
    await syncSpaceMembership(db, paperless, sharedId);
    await mirrorDocument(db, paperless, 1);
    const carolUser = await userOf(carolId);
    await paperless.updateUser(carolUser, { groups: [...paperless.users.get(carolUser)!.groups, 999] });

    await db.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, sharedId), eq(spaceMembers.memberId, carolId)));
    expect(await removeFromSpaceGroups(db, paperless, carolId, sharedId)).toBe(true);

    expect(paperless.users.get(carolUser)!.groups).toEqual([999]); // unrelated groups kept
    expect(paperless.visibleTo(carolUser)).not.toContain(1);
    expect(await removeFromSpaceGroups(db, paperless, carolId, sharedId)).toBe(false);
  });
});

describe("share users in the mirror (tenancy-document-shares)", { timeout: 60_000 }, () => {
  it("no shares = the space target (unchanged); viewer/editor shares add users; expired ones drop out", async () => {
    const { h, paperless, alice, bob, carol, paperlessUser, personal } = await household();
    try {
      const writes = paperless.tenancyWrites.length;
      expect(await mirrorDocument(h.db, paperless, 1)).toBe("unchanged");
      expect(paperless.tenancyWrites).toHaveLength(writes);

      await h.db.insert(documentShares).values([
        { paperlessDocId: 1, memberId: bob.id, role: "viewer", grantedBy: alice.id },
        { paperlessDocId: 1, memberId: carol.id, role: "editor", grantedBy: alice.id },
      ]);
      expect(await mirrorDocument(h.db, paperless, 1)).toBe("updated");
      const group = (await personal(alice.id)).paperlessGroupId!;
      const bobUser = await paperlessUser(bob.id);
      const carolUser = await paperlessUser(carol.id);
      expect(paperless.permissions.get(1)).toEqual({
        owner: await paperlessUser(alice.id),
        permissions: {
          view: { users: [bobUser, carolUser].sort((a, b) => a - b), groups: [group] },
          change: { users: [carolUser], groups: [group] },
        },
      });
      expect(paperless.visibleTo(bobUser)).toContain(1);
      expect(paperless.canChange(bobUser, 1)).toBe(false);
      expect(paperless.canChange(carolUser, 1)).toBe(true);
      expect(await mirrorDocument(h.db, paperless, 1)).toBe("unchanged");

      await h.db.execute(sql`UPDATE document_shares SET expires_at = now() - interval '1 hour' WHERE member_id = ${carol.id}`);
      expect(await mirrorDocument(h.db, paperless, 1)).toBe("updated");
      expect(paperless.permissions.get(1)!.permissions).toEqual({
        view: { users: [bobUser], groups: [group] },
        change: { users: [], groups: [group] },
      });
      expect(paperless.visibleTo(carolUser)).not.toContain(1);
    } finally {
      await h.close();
    }
  });
});
