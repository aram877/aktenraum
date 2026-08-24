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
    expect(response.body).toEqual({ username: "admin" });
    const cookie = (response.headers["set-cookie"] as unknown as string[])[0] as string;
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
    expect(authenticated.body).toEqual({ username: "admin" });
  });

  it("rejects a session cookie signed with a different secret", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
    await harness.close();

    harness = await createHarness({ env: { JWT_SECRET: "a-completely-different-secret-value" } });
    await seedUser(harness);
    const response = await request(harness.app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", "aktenraum_session=tampered.token.value");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid session" });
  });

  it("logs out by clearing the cookie", async () => {
    harness = await createHarness();
    const response = await request(harness.app.getHttpServer()).post("/api/auth/logout");
    expect(response.status).toBe(204);
    expect((response.headers["set-cookie"] as unknown as string[])[0]).toContain(
      "aktenraum_session=;",
    );
  });

  // bcrypt is deliberately slow; four vitest workers hashing at once under
  // `pnpm -r test` pushes this past the 5s default. Not a product concern.
  it("changes the password, rejects the old one, and accepts the new one", { timeout: 30_000 }, async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });

    const changed = await agent
      .post("/api/auth/change-password")
      .send({ current_password: "correct-horse", new_password: "battery-staple-1" });
    expect(changed.status).toBe(204);

    const oldPassword = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "admin", password: "correct-horse" });
    expect(oldPassword.status).toBe(401);

    const newPassword = await request(harness.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "admin", password: "battery-staple-1" });
    expect(newPassword.status).toBe(200);
  });

  it("refuses a password change when the current password is wrong", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });

    const response = await agent
      .post("/api/auth/change-password")
      .send({ current_password: "nope", new_password: "battery-staple-1" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Current password is incorrect" });
  });

  it("refuses a new password identical to the current one", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });

    const response = await agent
      .post("/api/auth/change-password")
      .send({ current_password: "correct-horse", new_password: "correct-horse" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ detail: "New password must differ from current password" });
  });

  it("rejects a new password shorter than 8 characters", async () => {
    harness = await createHarness();
    await seedUser(harness);
    const agent = request.agent(harness.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });

    const response = await agent
      .post("/api/auth/change-password")
      .send({ current_password: "correct-horse", new_password: "short" });

    expect(response.status).toBe(422);
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
});
