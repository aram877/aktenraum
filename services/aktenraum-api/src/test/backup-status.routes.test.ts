import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;
let dir: string;
let statusFile: string;

async function boot(): Promise<ReturnType<typeof request.agent>> {
  harness = await createHarness({
    gateway: new FakeGateway() as unknown as Partial<PaperlessGateway>,
    env: { BACKUP_STATUS_FILE: statusFile },
  });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  const agent = request.agent(harness.app.getHttpServer());
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
  return agent;
}

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aktenraum-backup-status-"));
  statusFile = join(dir, "backup-status.json");
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/health/backup", () => {
  it("requires a session", async () => {
    await boot();
    const response = await request(harness!.app.getHttpServer()).get("/api/health/backup");
    expect(response.status).toBe(401);
  });

  it("reports unknown when the status file is missing", async () => {
    const agent = await boot();
    const response = await agent.get("/api/health/backup");
    expect(response.status).toBe(200);
    expect(response.body.state).toBe("unknown");
  });

  it("reports unknown when the status file is malformed", async () => {
    await writeFile(statusFile, "{not json");
    const agent = await boot();
    expect((await agent.get("/api/health/backup")).body.state).toBe("unknown");
  });

  it("reports ok for a fresh backup", async () => {
    await writeFile(
      statusFile,
      JSON.stringify({
        checked_at: hoursAgo(0),
        healthy: true,
        message: "backups fresh: filesystem=1h postgres=1h postgres-aktenraum=1h",
        latest_snapshot_at: hoursAgo(1),
        max_age_hours: 36,
        last_run_at: hoursAgo(1),
        last_run_exit: 0,
      }),
    );
    const agent = await boot();
    const response = await agent.get("/api/health/backup");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: "ok", age_hours: 1, max_age_hours: 36 });
  });

  it("reports stale for an old backup", async () => {
    await writeFile(
      statusFile,
      JSON.stringify({
        checked_at: hoursAgo(0),
        healthy: false,
        message: "latest filesystem snapshot is 817h old (limit 36h)",
        latest_snapshot_at: hoursAgo(817),
        max_age_hours: 36,
        last_run_at: null,
        last_run_exit: null,
      }),
    );
    const agent = await boot();
    const response = await agent.get("/api/health/backup");
    expect(response.body).toMatchObject({ state: "stale", age_hours: 817 });
  });

  it("leaves the public /api/health untouched", async () => {
    await boot();
    const response = await request(harness!.app.getHttpServer()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
