import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;
let gateway: FakeGateway;
let agent: ReturnType<typeof request.agent>;

beforeEach(async () => {
  gateway = new FakeGateway({
    docs: [makeDoc({ id: 42, tags: [TAGS["ai-propagated"] as number, TAGS["ai-duplicate"] as number] })],
  });
  harness = await createHarness({ gateway: gateway as unknown as Partial<PaperlessGateway> });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  agent = request.agent(harness.app.getHttpServer());
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function tagsOf(docId: number): number[] {
  return (gateway.docs.get(docId)?.tags as number[]) ?? [];
}

describe("document actions used by the detail pages", () => {
  it("stars and unstars a document", async () => {
    expect((await agent.post("/api/documents/42/star")).status).toBe(200);
    expect(tagsOf(42)).toContain(TAGS.wichtig);
    expect((await agent.delete("/api/documents/42/star")).status).toBe(200);
    expect(tagsOf(42)).not.toContain(TAGS.wichtig);
  });

  it("moves a document to the trash", async () => {
    expect((await agent.delete("/api/documents/42")).status).toBe(204);
    expect(gateway.docs.has(42)).toBe(false);
    expect(gateway.trashed.has(42)).toBe(true);
  });

  it("dismisses a duplicate flag stickily", async () => {
    expect((await agent.post("/api/documents/42/dismiss-duplicate")).status).toBe(200);
    expect(tagsOf(42)).not.toContain(TAGS["ai-duplicate"]);
    expect(tagsOf(42)).toContain(TAGS["ai-duplicate-dismissed"]);
  });

  it("saves, normalises and clears type-specific fields", async () => {
    const saved = await agent
      .patch("/api/documents/42/type-fields")
      .send({ document_type: "Rechnung", fields: { gesamtbetrag: "21,42 EUR", iban: "DE00 1234" } });
    expect(saved.status).toBe(200);
    expect(saved.body.fields).toEqual({ gesamtbetrag: "EUR21.42", iban: "DE00 1234" });

    const cleared = await agent
      .patch("/api/documents/42/type-fields")
      .send({ document_type: "Rechnung", fields: { iban: null } });
    expect(cleared.body.fields).toEqual({ gesamtbetrag: "EUR21.42" });

    const detail = await agent.get("/api/documents/42/detail");
    expect(detail.body.type_fields).toEqual({ gesamtbetrag: "EUR21.42" });
  });

  it("rejects a field that does not belong to the document type", async () => {
    const response = await agent
      .patch("/api/documents/42/type-fields")
      .send({ document_type: "Rechnung", fields: { laufzeit: "24 Monate" } });
    expect(response.status).toBe(422);
  });
});
