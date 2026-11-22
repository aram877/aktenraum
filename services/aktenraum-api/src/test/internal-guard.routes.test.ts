import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway } from "./fake-gateway.js";
import { SERVICE_ENV, TEST_API_TOKEN, TEST_WORKER_TOKEN, asWorker, createHarness, type Harness } from "./harness.js";
import { registerPasskey } from "./passkey-helpers.js";

const BODY = { document_type: "Rechnung", fields: { gesamtbetrag: "21,42 EUR" } };

let harness: Harness | null = null;
let server: Parameters<typeof request>[0];
let agent: ReturnType<typeof request.agent>;

beforeEach(async () => {
  harness = await createHarness({
    gateway: new FakeGateway() as unknown as Partial<PaperlessGateway>,
    env: SERVICE_ENV,
  });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  server = harness.app.getHttpServer();
  agent = request.agent(server);
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
  await registerPasskey(agent);
});

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("PATCH /api/documents/:id/type-fields (UserOrInternalGuard)", () => {
  it("accepts the worker: worker credential, no session", async () => {
    const response = await asWorker(request(server).patch("/api/documents/42/type-fields")).send(BODY);
    expect(response.status).toBe(200);
    expect(response.body.fields).toEqual({ gesamtbetrag: "EUR21.42" });
  });

  it("accepts a logged-in user without an Authorization header", async () => {
    const response = await agent.patch("/api/documents/42/type-fields").send(BODY);
    expect(response.status).toBe(200);
  });

  it("rejects a wrong bearer credential even when a valid session cookie is present", async () => {
    for (const token of ["wrong", TEST_API_TOKEN]) {
      const response = await asWorker(agent.patch("/api/documents/42/type-fields"), token).send(BODY);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: "Invalid credential" });
    }
  });

  it("rejects a malformed Authorization header instead of falling back to the cookie", async () => {
    const response = await agent
      .patch("/api/documents/42/type-fields")
      .set("Authorization", `Basic ${TEST_WORKER_TOKEN}`)
      .send(BODY);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid credential" });
  });

  it("does not accept the old X-Aktenraum-Secret header as the worker", async () => {
    const response = await request(server)
      .patch("/api/documents/42/type-fields")
      .set("X-Aktenraum-Secret", TEST_WORKER_TOKEN)
      .send(BODY);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Not authenticated" });
  });

  it("rejects a request with neither credential nor session", async () => {
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

describe("worker principal on member routes", () => {
  it("does not open a member-only route with the worker credential", async () => {
    const library = await asWorker(request(server).get("/api/library/"));
    // A bearer header is judged alone (personal-access-tokens): not a token → 401.
    expect(library.status).toBe(401);
    expect(library.body).toEqual({ detail: "Invalid token" });
  });
});

describe("internal settings endpoints (InternalGuard)", () => {
  it("serve the worker with its credential", async () => {
    const model = await asWorker(request(server).get("/api/settings/active-llm-model"));
    expect(model.status).toBe(200);
    expect(typeof model.body.ollama_model).toBe("string");
  });

  it("do not accept a user session instead of the credential", async () => {
    const response = await agent.get("/api/settings/active-auto-approve-rules");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid credential" });
  });

  it("do not accept the api's own credential", async () => {
    const response = await asWorker(request(server).get("/api/settings/active-llm-model"), TEST_API_TOKEN);
    expect(response.status).toBe(401);
  });

  it("do not accept the old X-Aktenraum-Secret header", async () => {
    const response = await request(server)
      .get("/api/settings/active-llm-model")
      .set("X-Aktenraum-Secret", TEST_WORKER_TOKEN);
    expect(response.status).toBe(401);
  });

  it("reject an Authorization value with extra parts", async () => {
    const response = await request(server)
      .get("/api/settings/active-llm-model")
      .set("Authorization", `Bearer ${TEST_WORKER_TOKEN}, Bearer ${TEST_WORKER_TOKEN}`);
    expect(response.status).toBe(401);
  });
});
