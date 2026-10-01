import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(options: { gateway?: FakeGateway; env?: Record<string, string> } = {}) {
  const gateway = options.gateway ?? new FakeGateway();
  harness = await createHarness({
    gateway: gateway as unknown as Partial<PaperlessGateway>,
    env: options.env,
  });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  return { gateway, server: harness.app.getHttpServer() };
}

async function loggedIn(server: unknown, password = "correct-horse") {
  const agent = request.agent(server as Parameters<typeof request.agent>[0]);
  const response = await agent.post("/api/auth/login").send({ username: "admin", password });
  expect(response.status).toBe(200);
  return agent;
}

describe("login hardening", () => {
  it("throttles a username after repeated failures, even with the right password", { timeout: 60_000 }, async () => {
    const { server } = await boot();
    for (let i = 0; i < 10; i++) {
      const wrong = await request(server).post("/api/auth/login").send({ username: "admin", password: "nope" });
      expect(wrong.status).toBe(401);
    }
    const blocked = await request(server)
      .post("/api/auth/login")
      .send({ username: "Admin", password: "correct-horse" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("logs out every other session when the password changes", { timeout: 30_000 }, async () => {
    const { server } = await boot();
    const laptop = await loggedIn(server);
    const phone = await loggedIn(server);
    expect((await phone.get("/api/auth/me")).status).toBe(200);

    const changed = await laptop
      .post("/api/auth/change-password")
      .send({ current_password: "correct-horse", new_password: "battery-staple" });
    expect(changed.status).toBe(204);

    expect((await phone.get("/api/auth/me")).status).toBe(401);
    const fresh = await loggedIn(server, "battery-staple");
    expect((await fresh.get("/api/auth/me")).status).toBe(200);
  });
});

describe("internal secret", () => {
  it("only lets the CSRF check be skipped with the correct secret value", async () => {
    const { server } = await boot({ env: { WEBHOOK_SECRET: "s3cret" } });
    const agent = await loggedIn(server);

    const forged = await agent
      .post("/api/documents/42/star")
      .set("Sec-Fetch-Site", "cross-site")
      .set("X-Aktenraum-Secret", "guess");
    expect(forged.status).toBe(403);

    const internal = await agent
      .post("/api/documents/42/star")
      .set("Sec-Fetch-Site", "cross-site")
      .set("X-Aktenraum-Secret", "s3cret");
    expect(internal.status).toBe(200);
  });
});

describe("document streams", () => {
  it("never renders a non-PDF original inline", async () => {
    const gateway = new FakeGateway();
    gateway.openDocumentStream = async () =>
      new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
    const { server } = await boot({ gateway });
    const agent = await loggedIn(server);

    const preview = await agent.get("/api/documents/42/preview");
    expect(preview.headers["content-disposition"]).toBe("attachment");
    expect(preview.headers["content-security-policy"]).toBe("sandbox");
  });

  it("keeps PDFs inline so the SPA can embed them", async () => {
    const { server } = await boot();
    const agent = await loggedIn(server);
    const preview = await agent.get("/api/documents/42/preview");
    expect(preview.headers["content-disposition"]).toBeUndefined();
    expect(preview.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("uploads", () => {
  it("rejects an oversized file on its own and leaves no temp files behind", async () => {
    const before = new Set(await readdir(tmpdir()));
    const { gateway, server } = await boot({ env: { UPLOAD_MAX_FILE_BYTES: "16" } });
    const agent = await loggedIn(server);

    const response = await agent
      .post("/api/documents/upload")
      .attach("files", Buffer.from("%PDF-1.4 small"), { filename: "ok.pdf", contentType: "application/pdf" })
      .attach("files", Buffer.from("%PDF-1.4 this one is far too large"), {
        filename: "big.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(200);
    expect(response.body.results.map((r: { status: string }) => r.status)).toEqual(["accepted", "error"]);
    expect(gateway.uploads).toHaveLength(1);
    const leftovers = (await readdir(tmpdir())).filter((name) => !before.has(name) && /^[0-9a-f]{32}$/.test(name));
    expect(leftovers).toEqual([]);
  });
});
