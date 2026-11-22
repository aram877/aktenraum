import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { members, personalAccessTokens, users } from "../db/schema.js";
import { createHarness, type Harness } from "../test/harness.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { hashPassword } from "./passwords.js";
import { TOKEN_SCOPES } from "./principal.js";
import {
  DISPLAY_PREFIX_LENGTH,
  MAX_ACTIVE_TOKENS,
  TokenLimitError,
  TokenService,
  hashTokenValue,
  isTokenValue,
  parseStoredScopes,
} from "./tokens.service.js";

let h: Harness;
let tokens: TokenService;
let member: { memberId: number; householdId: number };
let other: { memberId: number; householdId: number };

const ago = (interval: string) => sql.raw(`now() - interval '${interval}'`) as unknown as string;

beforeEach(async () => {
  h = await createHarness();
  const hash = await hashPassword("password-123");
  await h.db.insert(users).values({ username: "alice", passwordHash: hash });
  await h.db.insert(users).values({ username: "bob", passwordHash: hash });
  await h.app.get(TenancyService).reconcile();
  const rows = await h.db.select().from(members).orderBy(members.id);
  member = { memberId: rows[0]!.id, householdId: rows[0]!.householdId };
  other = { memberId: rows[1]!.id, householdId: rows[1]!.householdId };
  tokens = h.app.get(TokenService);
});

afterEach(async () => {
  await h.close();
});

const row = async (id: number) =>
  (await h.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, id)))[0]!;

describe("TokenService.create", () => {
  it("returns an akt_pat_ value with 256 bits once and stores only its sha256", async () => {
    const { token, value } = await tokens.create(member, { name: "Scanner", scopes: ["upload"], expiresInDays: 90 });
    expect(value).toMatch(/^akt_pat_[A-Za-z0-9_-]{43}$/);
    expect(isTokenValue(value)).toBe(true);
    expect(token).toMatchObject({ name: "Scanner", scopes: ["upload"], state: "active", last_used_at: null });
    expect(token).not.toHaveProperty("value");
    expect(token.display_prefix).toBe(value.slice(0, DISPLAY_PREFIX_LENGTH));

    const stored = await row(token.id);
    expect(stored.tokenHash).toBe(hashTokenValue(value));
    expect(JSON.stringify(stored)).not.toContain(value);
    expect(JSON.stringify(stored)).not.toContain(value.slice(DISPLAY_PREFIX_LENGTH));
  });

  it("computes the expiry in SQL: N days from now", async () => {
    const { token } = await tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 30 });
    const [check] = await h.db
      .select({
        ok: sql<boolean>`(${personalAccessTokens.expiresAt} > now() + interval '29 days' AND ${personalAccessTokens.expiresAt} <= now() + interval '30 days')`,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, token.id));
    expect(check?.ok).toBe(true);
  });

  it("caps active tokens at 25; expired and revoked ones don't count", async () => {
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      await tokens.create(member, { name: `t${i}`, scopes: ["upload"], expiresInDays: 1 });
    }
    await expect(tokens.create(member, { name: "one more", scopes: ["upload"], expiresInDays: 1 })).rejects.toBeInstanceOf(TokenLimitError);
    // Another member is unaffected.
    await tokens.create(other, { name: "bob's", scopes: ["upload"], expiresInDays: 1 });

    const list = await tokens.list(member.memberId);
    await tokens.revoke(member.memberId, list[0]!.id, member.memberId);
    await h.db.update(personalAccessTokens).set({ expiresAt: ago("1 second") }).where(eq(personalAccessTokens.id, list[1]!.id));
    await tokens.create(member, { name: "a", scopes: ["upload"], expiresInDays: 1 });
    await tokens.create(member, { name: "b", scopes: ["upload"], expiresInDays: 1 });
    await expect(tokens.create(member, { name: "c", scopes: ["upload"], expiresInDays: 1 })).rejects.toBeInstanceOf(TokenLimitError);
  });

  it("refuses an expiry outside 1..365 days and an empty scope list", async () => {
    await expect(tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 0 })).rejects.toThrow();
    await expect(tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 366 })).rejects.toThrow();
    await expect(tokens.create(member, { name: "t", scopes: [], expiresInDays: 1 })).rejects.toThrow();
  });
});

describe("TokenService.resolve", () => {
  it("resolves an active token to its member and scopes", async () => {
    const { token, value } = await tokens.create(member, { name: "t", scopes: ["documents:read", "upload"], expiresInDays: 1 });
    const resolved = await tokens.resolve(value, "10.0.0.1");
    expect(resolved).toMatchObject({
      status: "active",
      token: { id: token.id, memberId: member.memberId, username: "alice", name: "t", scopes: ["documents:read", "upload"] },
    });
  });

  it("is expired one second after expires_at, active one minute before", async () => {
    const { token, value } = await tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 1 });
    await h.db.update(personalAccessTokens).set({ expiresAt: sql`now() + interval '1 minute'` as unknown as string }).where(eq(personalAccessTokens.id, token.id));
    expect((await tokens.resolve(value, null)).status).toBe("active");
    await h.db.update(personalAccessTokens).set({ expiresAt: ago("1 second") }).where(eq(personalAccessTokens.id, token.id));
    expect(await tokens.resolve(value, null)).toMatchObject({ status: "expired", id: token.id, auditDue: true });
    // The expired-use audit is due at most once an hour.
    expect(await tokens.resolve(value, null)).toMatchObject({ status: "expired", auditDue: false });
    expect((await tokens.list(member.memberId))[0]?.state).toBe("expired");
  });

  it("answers revoked, unknown and malformed values without a match", async () => {
    const { token, value } = await tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 1 });
    expect(await tokens.revoke(member.memberId, token.id, member.memberId)).toMatchObject({ changed: true });
    expect(await tokens.resolve(value, null)).toEqual({ status: "revoked" });
    expect(await tokens.resolve(`akt_pat_${"A".repeat(43)}`, null)).toEqual({ status: "unknown" });
    expect(await tokens.resolve("akt_pat_short", null)).toEqual({ status: "unknown" });
    expect(await tokens.resolve(value.slice(0, -1), null)).toEqual({ status: "unknown" });
  });

  it("records the last use at most once a minute", async () => {
    const { token, value } = await tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 1 });
    await tokens.resolve(value, "10.0.0.1");
    const first = await row(token.id);
    expect(first.lastUsedIp).toBe("10.0.0.1");
    expect(first.lastUsedAt).not.toBeNull();

    await tokens.resolve(value, "10.0.0.2");
    expect((await row(token.id)).lastUsedIp).toBe("10.0.0.1");

    await h.db.update(personalAccessTokens).set({ lastUsedAt: ago("61 seconds") }).where(eq(personalAccessTokens.id, token.id));
    await tokens.resolve(value, "10.0.0.2");
    expect((await row(token.id)).lastUsedIp).toBe("10.0.0.2");
  });

  it("validates the stored scope list on read: unknown entries never grant anything", async () => {
    const { token, value } = await tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 1 });
    await h.db.update(personalAccessTokens).set({ scopes: "upload,household:admin,settings:write,bogus" }).where(eq(personalAccessTokens.id, token.id));
    const resolved = await tokens.resolve(value, null);
    expect(resolved.status === "active" && resolved.token.scopes).toEqual(["upload"]);
    expect(parseStoredScopes(` ${TOKEN_SCOPES.join(" , ")} ,upload,`)).toEqual([...TOKEN_SCOPES]);
  });
});

describe("TokenService.revoke / revokeAllOfMember / list", () => {
  it("revokes only the member's own tokens, idempotently", async () => {
    const { token } = await tokens.create(member, { name: "t", scopes: ["upload"], expiresInDays: 1 });
    expect(await tokens.revoke(other.memberId, token.id, other.memberId)).toBeNull();
    expect((await row(token.id)).revokedAt).toBeNull();
    expect(await tokens.revoke(member.memberId, token.id, member.memberId)).toMatchObject({ changed: true, token: { name: "t" } });
    expect(await tokens.revoke(member.memberId, token.id, member.memberId)).toMatchObject({ changed: false });
    expect(await row(token.id)).toMatchObject({ revokedReason: "user", revokedByMemberId: member.memberId });
    expect((await tokens.list(member.memberId))[0]?.state).toBe("revoked");
  });

  it("revokes every token of a member with the reason and actor", async () => {
    await tokens.create(member, { name: "a", scopes: ["upload"], expiresInDays: 1 });
    await tokens.create(member, { name: "b", scopes: ["upload"], expiresInDays: 1 });
    const { token: kept } = await tokens.create(other, { name: "bob", scopes: ["upload"], expiresInDays: 1 });
    const revoked = await tokens.revokeAllOfMember(member.memberId, "member_removed", other.memberId);
    expect(revoked.map((t) => t.name).sort()).toEqual(["a", "b"]);
    expect((await tokens.list(member.memberId)).every((t) => t.state === "revoked")).toBe(true);
    expect((await row(kept.id)).revokedAt).toBeNull();
  });

  it("lists newest first and drops tokens that ended more than 30 days ago", async () => {
    const { token: old } = await tokens.create(member, { name: "old", scopes: ["upload"], expiresInDays: 1 });
    const { token: gone } = await tokens.create(member, { name: "gone", scopes: ["upload"], expiresInDays: 1 });
    await tokens.create(member, { name: "new", scopes: ["upload"], expiresInDays: 1 });
    await h.db.update(personalAccessTokens).set({ expiresAt: ago("29 days") }).where(eq(personalAccessTokens.id, old.id));
    await h.db.update(personalAccessTokens).set({ revokedAt: ago("31 days") }).where(eq(personalAccessTokens.id, gone.id));
    const names = (await tokens.list(member.memberId)).map((t) => t.name);
    expect(names).toEqual(["new", "old"]);
    expect(JSON.stringify(await tokens.list(member.memberId))).not.toMatch(/token_hash|tokenHash/);
  });
});
