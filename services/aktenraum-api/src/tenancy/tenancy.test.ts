import { afterEach, describe, expect, it } from "vitest";

import { households, members, spaceMembers, spaces, users } from "../db/schema.js";
import { createHarness, type Harness } from "../test/harness.js";
import { PERSONAL_SPACE_NAME } from "./reconcile.js";
import { TenancyService } from "./tenancy.service.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function snapshot(h: Harness) {
  return {
    households: await h.db.select().from(households),
    members: await h.db.select().from(members),
    spaces: await h.db.select().from(spaces),
    spaceMembers: await h.db.select().from(spaceMembers),
  };
}

describe("tenancy reconcile", () => {
  it("fresh database without users: one household, no members", async () => {
    harness = await createHarness();
    const state = await snapshot(harness);
    expect(state.households).toHaveLength(1);
    expect(state.members).toHaveLength(0);
    expect(state.spaces).toHaveLength(0);
  });

  it("bootstrap user becomes the household admin with a personal space it owns", async () => {
    harness = await createHarness({
      env: { BOOTSTRAP_USERNAME: "aram", BOOTSTRAP_PASSWORD: "test1234" },
    });
    const state = await snapshot(harness);
    const [user] = await harness.db.select().from(users);

    expect(state.households).toHaveLength(1);
    expect(state.members).toEqual([
      expect.objectContaining({
        householdId: state.households[0]?.id,
        userId: user?.id,
        role: "admin",
        paperlessUserId: null,
      }),
    ]);
    expect(state.spaces).toEqual([
      expect.objectContaining({
        householdId: state.households[0]?.id,
        kind: "personal",
        name: PERSONAL_SPACE_NAME,
        personalMemberId: state.members[0]?.id,
        paperlessGroupId: null,
      }),
    ]);
    expect(state.spaceMembers).toEqual([
      expect.objectContaining({ spaceId: state.spaces[0]?.id, memberId: state.members[0]?.id, role: "owner" }),
    ]);
  });

  it("an existing user without tenancy rows (upgraded install) is reconciled", async () => {
    harness = await createHarness();
    await harness.db.insert(users).values({ username: "existing", passwordHash: "x" });

    const report = await harness.app.get(TenancyService).reconcile();

    expect(report).toMatchObject({ householdCreated: false, membersCreated: 1, personalSpacesCreated: 1 });
    const state = await snapshot(harness);
    expect(state.members.map((m) => m.role)).toEqual(["admin"]);
    expect(state.spaces).toHaveLength(1);
  });

  it("is idempotent across restarts", async () => {
    harness = await createHarness({
      env: { BOOTSTRAP_USERNAME: "aram", BOOTSTRAP_PASSWORD: "test1234" },
    });
    const before = await snapshot(harness);

    const report = await harness.app.get(TenancyService).reconcile();

    expect(report).toEqual({
      householdId: before.households[0]?.id,
      householdCreated: false,
      membersCreated: 0,
      personalSpacesCreated: 0,
      spaceOwnersRepaired: 0,
    });
    expect(await snapshot(harness)).toEqual(before);
  });

  it("a second user becomes a plain member with its own personal space", async () => {
    harness = await createHarness({
      env: { BOOTSTRAP_USERNAME: "aram", BOOTSTRAP_PASSWORD: "test1234" },
    });
    const [second] = await harness.db
      .insert(users)
      .values({ username: "partner", passwordHash: "x" })
      .returning();

    await harness.app.get(TenancyService).reconcile();

    const state = await snapshot(harness);
    expect(state.households).toHaveLength(1);
    const partner = state.members.find((m) => m.userId === second?.id);
    expect(partner?.role).toBe("member");
    expect(state.members.filter((m) => m.role === "admin")).toHaveLength(1);
    const partnerSpace = state.spaces.find((s) => s.personalMemberId === partner?.id);
    expect(partnerSpace?.kind).toBe("personal");
    expect(state.spaceMembers).toContainEqual(
      expect.objectContaining({ spaceId: partnerSpace?.id, memberId: partner?.id, role: "owner" }),
    );
  });

  it("restores a missing owner row on an existing personal space", async () => {
    harness = await createHarness({
      env: { BOOTSTRAP_USERNAME: "aram", BOOTSTRAP_PASSWORD: "test1234" },
    });
    await harness.db.delete(spaceMembers);

    const report = await harness.app.get(TenancyService).reconcile();

    expect(report.spaceOwnersRepaired).toBe(1);
    expect(report.personalSpacesCreated).toBe(0);
    expect((await snapshot(harness)).spaceMembers).toHaveLength(1);
  });

  it("the database refuses a personal space without a member and a second personal space per member", async () => {
    harness = await createHarness({
      env: { BOOTSTRAP_USERNAME: "aram", BOOTSTRAP_PASSWORD: "test1234" },
    });
    const { households: [household], members: [member] } = await snapshot(harness);
    await expect(
      harness.db.insert(spaces).values({ householdId: household!.id, name: "x", kind: "personal" }),
    ).rejects.toThrow();
    await expect(
      harness.db
        .insert(spaces)
        .values({ householdId: household!.id, name: "y", kind: "personal", personalMemberId: member!.id }),
    ).rejects.toThrow();
  });
});
