import { describe, expect, it } from "vitest";

import { PaperlessAuthError, PaperlessNotFoundError } from "../paperless/errors.js";
import { FakeGateway, makeDoc } from "./fake-gateway.js";

const perms = (owner: number) => ({ owner, permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } } });

describe("FakeGateway per-token views", () => {
  async function twoUsers() {
    const fake = new FakeGateway({ docs: [makeDoc({ id: 1 }), makeDoc({ id: 2 }), makeDoc({ id: 3 })] });
    const alice = await fake.createUser({ username: "ak-1", password: "x", permissions: [] });
    const bob = await fake.createUser({ username: "ak-2", password: "x", permissions: [] });
    fake.permissions.set(1, perms(alice.id));
    fake.permissions.set(2, perms(bob.id));
    return { fake, alice: fake.forToken(await fake.mintUserToken(alice.id, "ak-1")), bob: fake.forToken(await fake.mintUserToken(bob.id, "ak-2")) };
  }

  it("lists and opens only what the user may see (no-permission fixtures count as ownerless)", async () => {
    const { alice } = await twoUsers();
    const listed = (await alice.searchDocuments({})) as { results: { id: number }[]; count: number };
    expect(listed.results.map((d) => d.id)).toEqual([1, 3]);
    expect(listed.count).toBe(2);
    await expect(alice.getDocument(2)).rejects.toBeInstanceOf(PaperlessNotFoundError);
  });

  it("an unknown token and a rejected token answer 401", async () => {
    const { fake } = await twoUsers();
    await expect(fake.forToken("nope").getDocument(1)).rejects.toBeInstanceOf(PaperlessAuthError);
    fake.rejectOnce.add("tok-100");
    const alice = fake.forToken("tok-100");
    await expect(alice.getDocument(1)).rejects.toBeInstanceOf(PaperlessAuthError);
    expect((await alice.getDocument(1)).id).toBe(1);
  });

  it("tasks and uploads belong to the token's user", async () => {
    const { fake, alice, bob } = await twoUsers();
    await alice.uploadDocument({ content: new Uint8Array(), filename: "a.pdf" });
    expect(fake.uploads.at(-1)?.owner).toBe(100);
    fake.tasks.push({ task_id: "t1", owner: 100 }, { task_id: "t2", owner: 101 });
    expect((await bob.listConsumeTasks()).map((t) => t.task_id)).toEqual(["t2"]);
    expect(await bob.getTasks("t1")).toEqual([]);
  });
});
