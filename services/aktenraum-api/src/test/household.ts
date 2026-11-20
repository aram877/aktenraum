import { eq } from "drizzle-orm";
import request from "supertest";
import { vi } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { documentSpaces, members, spaces, users } from "../db/schema.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { FakeGateway, TAGS, makeDoc } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

const PROPAGATED = TAGS["ai-propagated"] as number;

/**
 * Alice (household admin), Bob and Carol (members). Personal documents:
 * Alice 1 + 3, Bob 2, Carol 5. Paperless permissions match the home spaces.
 */
export async function household(
  docs: PaperlessDocument[] = [1, 2, 3, 5].map((id) => makeDoc({ id, tags: [PROPAGATED] })),
  env?: Record<string, string>,
) {
  const paperless = new FakeGateway({ docs });
  const vectorStore = {
    setSpaceByDocId: vi.fn(async (_docId: number, _space: unknown) => undefined),
    deleteByDocId: vi.fn(async () => undefined),
  };
  const h: Harness = await createHarness({ gateway: paperless as unknown as Partial<PaperlessGateway>, vectorStore, env });
  const password = await hashPassword("password-123");
  await h.db.insert(users).values([
    { username: "alice", passwordHash: password },
    { username: "bob", passwordHash: password },
    { username: "carol", passwordHash: password },
  ]);
  await h.app.get(TenancyService).reconcile();
  const all = await h.db.select().from(members);
  const byName = async (name: string) => {
    const [u] = await h.db.select().from(users).where(eq(users.username, name));
    return all.find((m) => m.userId === u!.id)!;
  };
  const alice = await byName("alice");
  const bob = await byName("bob");
  const carol = await byName("carol");
  const gateways = h.app.get(MemberGateways);
  for (const m of [alice, bob, carol]) await gateways.forMember(m.id);
  const paperlessUser = async (memberId: number) =>
    (await h.db.select().from(members).where(eq(members.id, memberId)))[0]!.paperlessUserId!;
  const personal = async (memberId: number) =>
    (await h.db.select().from(spaces).where(eq(spaces.personalMemberId, memberId)))[0]!;
  const own = async (docId: number, memberId: number) => {
    const space = await personal(memberId);
    paperless.permissions.set(docId, {
      owner: await paperlessUser(memberId),
      permissions: {
        view: { users: [], groups: [space.paperlessGroupId!] },
        change: { users: [], groups: [space.paperlessGroupId!] },
      },
    });
    await h.db.insert(documentSpaces).values({ paperlessDocId: docId, spaceId: space.id });
  };
  await own(1, alice.id);
  await own(3, alice.id);
  await own(2, bob.id);
  await own(5, carol.id);

  const login = async (username: string) => {
    const agent = request.agent(h.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username, password: "password-123" }).expect(200);
    return agent;
  };
  return {
    h,
    paperless,
    vectorStore,
    alice,
    bob,
    carol,
    paperlessUser,
    personal,
    own,
    asAlice: await login("alice"),
    asBob: await login("bob"),
    asCarol: await login("carol"),
  };
}

export type Agent = Awaited<ReturnType<typeof household>>["asAlice"];

export async function createSpace(agent: Agent, name = "Haushalt"): Promise<number> {
  return (await agent.post("/api/spaces").send({ name }).expect(201)).body.id as number;
}
