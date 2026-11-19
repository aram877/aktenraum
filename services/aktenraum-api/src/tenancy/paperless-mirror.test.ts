import { afterEach, describe, expect, it } from "vitest";

import { documentSpaces, members, spaces } from "../db/schema.js";
import { FakeGateway, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import {
  PAPERLESS_MEMBER_PERMISSIONS,
  memberUsername,
  mirrorDocument,
  provisionMemberUser,
  provisionSpaceGroup,
  spaceGroupName,
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
