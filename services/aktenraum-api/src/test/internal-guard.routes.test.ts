import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

const SECRET = "s3cret-for-tests";
const BODY = { document_type: "Rechnung", fields: { gesamtbetrag: "21,42 EUR" } };

let harness: Harness | null = null;
let server: Parameters<typeof request>[0];
let agent: ReturnType<typeof request.agent>;

beforeEach(async () => {
  harness = await createHarness({
    gateway: new FakeGateway() as unknown as Partial<PaperlessGateway>,
    env: { WEBHOOK_SECRET: SECRET },
  });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  server = harness.app.getHttpServer();
  agent = request.agent(server);
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("PATCH /api/documents/:id/type-fields (UserOrInternalGuard)", () => {
  it("accepts the worker: correct secret, no session", async () => {
    const response = await request(server)
      .patch("/api/documents/42/type-fields")
      .set("X-Aktenraum-Secret", SECRET)
      .send(BODY);
    expect(response.status).toBe(200);
    expect(response.body.fields).toEqual({ gesamtbetrag: "EUR21.42" });
  });

  it("accepts a logged-in user without a secret header", async () => {
    const response = await agent.patch("/api/documents/42/type-fields").send(BODY);
    expect(response.status).toBe(200);
  });

  it("rejects a wrong secret even when a valid session cookie is present", async () => {
    const response = await agent
      .patch("/api/documents/42/type-fields")
      .set("X-Aktenraum-Secret", "wrong")
      .send(BODY);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid secret" });
  });

  it("rejects a request with neither secret nor session", async () => {
    const response = await request(server).patch("/api/documents/42/type-fields").send(BODY);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Not authenticated" });
  });

  it("rejects an invalid session cookie", async () => {
    const response = await request(server)
      .patch("/api/documents/42/type-fields")
      .set("Cookie", "aktenraum_session=not-a-jwt")
      .send(BODY);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid session" });
  });
});

describe("internal settings endpoints (InternalGuard)", () => {
  it("serve the worker with the correct secret", async () => {
    const model = await request(server)
      .get("/api/settings/active-llm-model")
      .set("X-Aktenraum-Secret", SECRET);
    expect(model.status).toBe(200);
    expect(typeof model.body.ollama_model).toBe("string");
  });

  it("do not accept a user session instead of the secret", async () => {
    const response = await agent.get("/api/settings/active-auto-approve-rules");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Bad secret" });
  });

  it("reject a repeated secret header (Node joins it to 'a, b')", async () => {
    const response = await request(server)
      .get("/api/settings/active-llm-model")
      .set("X-Aktenraum-Secret", `${SECRET}, ${SECRET}`);
    expect(response.status).toBe(401);
  });
});
