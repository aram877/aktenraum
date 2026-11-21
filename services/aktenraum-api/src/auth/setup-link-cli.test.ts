import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { credentialAudit, setupTokens, users } from "../db/schema.js";
import { createHarness, type Harness } from "../test/harness.js";
import { ORIGIN } from "../test/passkey-helpers.js";
import { SoftAuthenticator } from "../test/soft-authenticator.js";
import { UnknownMemberError, issueSetupLinkForUsername } from "./setup-link-cli.js";
import { hashSetupToken } from "./setup-links.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("setup-link CLI", { timeout: 30_000 }, () => {
  it("prints <origin>/setup/<token> for a passwordless bootstrap admin, stores only the hash, audits actor NULL", async () => {
    harness = await createHarness({ env: { BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "" } });
    const h = harness;
    const url = await issueSetupLinkForUsername(h.db, h.settings, "admin");
    expect(url).toMatch(/^http:\/\/localhost:8080\/setup\/[A-Za-z0-9_-]{43}$/);
    const token = url.split("/").pop()!;
    const [row] = await h.db.select().from(setupTokens);
    expect(row).toMatchObject({ tokenHash: hashSetupToken(token), createdByMemberId: null });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await h.db.select().from(credentialAudit).where(eq(credentialAudit.event, "setup_link_created"))).toEqual([
      expect.objectContaining({ actorMemberId: null, detail: "host" }),
    ]);

    // The link works end to end: first passkey, recovery codes, a full session.
    const agent = request.agent(h.app.getHttpServer());
    const begin = await agent.post(`/api/setup/${token}/register/begin`).set("Origin", ORIGIN).send({}).expect(200);
    const finish = await agent
      .post(`/api/setup/${token}/register/finish`)
      .set("Origin", ORIGIN)
      .send({ ceremony: begin.body.ceremony, response: new SoftAuthenticator().register(begin.body.options) })
      .expect(200);
    expect(finish.body.recovery_codes).toHaveLength(10);
    await agent.get("/api/library/").expect((res) => expect(res.status).not.toBe(403));
    const [admin] = await h.db.select().from(users);
    expect(admin!.passwordHash).toBe("!");
  });

  it("refuses an unknown username", async () => {
    harness = await createHarness({ env: { BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "" } });
    await expect(issueSetupLinkForUsername(harness.db, harness.settings, "nobody")).rejects.toBeInstanceOf(UnknownMemberError);
  });
});
