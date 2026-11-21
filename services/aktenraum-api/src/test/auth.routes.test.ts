import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function seedUser(h: Harness, username = "admin", password = "correct-horse"): Promise<void> {
  await h.db.insert(users).values({ username, passwordHash: await hashPassword(password) });
}

describe("auth routes", () => {
  it("logs in and sets an httpOnly SameSite=Lax cookie", async () => {
    harness = await createHarness();
    await seedUser(harness);

    const response = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "admin", password: "correct-horse" });

    expect(response.status).toBe(200);
    // A password only leads to passkey enrolment (auth-passkeys).
    expect(response.body).toEqual({ username: "admin", enrolment_required: true });
    const cookie = (response.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("aktenraum_session=")) as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  it("rejects a wrong password with 401 and FastAPI's detail shape", async () => {
    harness = await createHarness();
    await seedUser(harness);

    const response = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "admin", password: "wrong" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid credentials" });
  });

  it("rejects an unknown user with the same message as a wrong password", async () => {
    harness = await createHarness();
    const response = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "nobody", password: "whatever" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid credentials" });
  });

  it("returns 422 with a field-level detail list for a malformed body", async () => {
    harness = await createHarness();
    const response = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "admin" });

    expect(response.status).toBe(422);
    expect(Array.isArray(response.body.detail)).toBe(true);
    expect(response.body.detail[0].loc).toEqual(["password"]);
  });

  it("guards /me and returns the user once authenticated", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());

    const anonymous = await request(harness.app.getHttpServer()).get("/api/auth/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ detail: "Not authenticated" });

    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
    const authenticated = await agent.get("/api/auth/me");
    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toEqual({
      username: "admin",
      household_role: "admin",
      enrolment_required: true,
      auth_method: "password",
    });
  });

  it("rejects a JWT-shaped cookie from before the upgrade, and unknown tokens", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const jwtShaped =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwicHdmIjoiYWJjIiwiaWF0IjoxLCJleHAiOjk5OTk5OTk5OTl9.c2lnbmF0dXJl";
    for (const value of [jwtShaped, "tampered.token.value"]) {
      const response = await request(harness.app.getHttpServer())
        .get("/api/auth/me")
        .set("Cookie", `aktenraum_session=${value}`);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: "Invalid session" });
    }
  });

  it("logs out by clearing the cookie", async () => {
    harness = await createHarness();
    const response = await request(harness.app.getHttpServer()).post("/api/auth/logout");
    expect(response.status).toBe(204);
    expect((response.headers["set-cookie"] as unknown as string[]).some((c) => c.startsWith("aktenraum_session=;"))).toBe(true);
  });

  it("no longer offers a password change", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
    await agent
      .post("/api/auth/change-password")
      .send({ current_password: "correct-horse", new_password: "battery-staple-1" })
      .expect(404);
  });

  it("bootstraps exactly one user and is idempotent across restarts", async () => {
    const env = { BOOTSTRAP_USERNAME: "seeded", BOOTSTRAP_PASSWORD: "seeded-password" };
    harness = await createHarness({ env });
    const first = await harness.db.select().from(users);
    expect(first).toHaveLength(1);

    const login = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "seeded", password: "seeded-password" });
    expect(login.status).toBe(200);
  });

  it("does not bootstrap when the credentials are absent", async () => {
    harness = await createHarness();
    expect(await harness.db.select().from(users)).toHaveLength(0);
  });

  it("bootstraps a passwordless admin when BOOTSTRAP_PASSWORD is empty", async () => {
    harness = await createHarness({ env: { BOOTSTRAP_USERNAME: "seeded", BOOTSTRAP_PASSWORD: "" } });
    const [user] = await harness.db.select().from(users);
    expect(user).toMatchObject({ username: "seeded", passwordHash: "!" });
    await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "seeded", password: "!" })
      .expect(401);
  });
});
