import { createHash, randomBytes } from "node:crypto";

import { logger } from "@aktenraum/core";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AuthUser } from "../auth/auth.service.js";
import { hashPassword } from "../auth/passwords.js";
import type { MemberPrincipal } from "../auth/principal.js";
import { DB, type Database } from "../db/db.module.js";
import { invites, members, users } from "../db/schema.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

export const INVITE_INVALID = "Einladung ungültig oder abgelaufen";

export interface CreatedInvite {
  id: number;
  /** Shown exactly once; only its SHA-256 is stored. */
  token: string;
  expires_at: string;
}

export interface PendingInvite {
  id: number;
  created_at: string;
  expires_at: string;
}

export interface HouseholdMember {
  id: number;
  username: string;
  role: "admin" | "member";
  joined_at: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Still redeemable: not used, not revoked, not expired (compared in SQL — one clock). */
const pending = () =>
  and(isNull(invites.redeemedAt), isNull(invites.revokedAt), sql`${invites.expiresAt} > now()`);

/**
 * Household membership (ADR-009, ADR-010 "Adding a member"): the household
 * admin creates single-use invite links (7 days); an invitee redeems one with a
 * username and password — the interim form until passkey enrolment replaces it
 * (ADR-010 step 4) — and becomes a `member` with their own personal space.
 */
@Injectable()
export class HouseholdService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tenancy: TenancyService,
    private readonly gateways: MemberGateways,
  ) {}

  async createInvite(admin: MemberPrincipal): Promise<CreatedInvite> {
    const token = randomBytes(32).toString("base64url");
    const [row] = await this.db
      .insert(invites)
      .values({
        tokenHash: hashToken(token),
        householdId: admin.householdId,
        role: "member",
        createdByMemberId: admin.memberId,
        expiresAt: sql`now() + interval '7 days'` as unknown as string,
      })
      .returning({ id: invites.id, expiresAt: invites.expiresAt });
    logger.info("invite_created", { invite_id: row!.id, by_member: admin.memberId });
    return { id: row!.id, token, expires_at: row!.expiresAt };
  }

  async listInvites(): Promise<PendingInvite[]> {
    const rows = await this.db
      .select({ id: invites.id, createdAt: invites.createdAt, expiresAt: invites.expiresAt })
      .from(invites)
      .where(pending())
      .orderBy(asc(invites.createdAt));
    return rows.map((r) => ({ id: r.id, created_at: r.createdAt, expires_at: r.expiresAt }));
  }

  async revokeInvite(id: number): Promise<void> {
    const revoked = await this.db
      .update(invites)
      .set({ revokedAt: sql`now()` as unknown as string })
      .where(and(eq(invites.id, id), pending()))
      .returning({ id: invites.id });
    if (revoked.length === 0) throw new NotFoundException(`Invite ${id} not found`);
    logger.info("invite_revoked", { invite_id: id });
  }

  async listMembers(): Promise<HouseholdMember[]> {
    const rows = await this.db
      .select({ id: members.id, username: users.username, role: members.role, joinedAt: members.createdAt })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .orderBy(asc(members.id));
    return rows.map((r) => ({ id: r.id, username: r.username, role: r.role, joined_at: r.joinedAt }));
  }

  async directory(): Promise<{ id: number; username: string }[]> {
    return this.db
      .select({ id: members.id, username: users.username })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .orderBy(asc(members.id));
  }

  /** Whether a link is redeemable; every other state is the same 404 (no oracle). */
  async checkInvite(token: string): Promise<{ expires_at: string }> {
    const rows = await this.db
      .select({ expiresAt: invites.expiresAt })
      .from(invites)
      .where(and(eq(invites.tokenHash, hashToken(token)), pending()))
      .limit(1);
    if (rows[0] === undefined) throw new NotFoundException(INVITE_INVALID);
    return { expires_at: rows[0].expiresAt };
  }

  /**
   * Claims the invite first (conditional update — concurrent redemptions can't
   * both win), then creates the user, member and personal space, then
   * provisions Paperless. A Paperless failure doesn't undo the redemption: the
   * member exists, logs in, and provisioning retries on their first request.
   */
  async redeem(token: string, input: { username: string; password: string }): Promise<AuthUser> {
    const username = input.username.trim();
    const taken = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (taken.length > 0) {
      await this.checkInvite(token); // an invalid link still answers 404 first
      throw new ConflictException("Benutzername bereits vergeben");
    }

    const claimed = await this.db
      .update(invites)
      .set({ redeemedAt: sql`now()` as unknown as string })
      .where(and(eq(invites.tokenHash, hashToken(token)), pending()))
      .returning({ id: invites.id });
    const inviteId = claimed[0]?.id;
    if (inviteId === undefined) throw new NotFoundException(INVITE_INVALID);

    let user: AuthUser;
    try {
      const [created] = await this.db
        .insert(users)
        .values({ username, passwordHash: await hashPassword(input.password) })
        .returning({ id: users.id, username: users.username, passwordHash: users.passwordHash });
      user = created!;
    } catch (error: unknown) {
      // Lost a race on the username: give the invite back.
      await this.db.update(invites).set({ redeemedAt: null }).where(eq(invites.id, inviteId));
      logger.warn("invite_redeem_user_insert_failed", { invite_id: inviteId, error: String(error) });
      throw new ConflictException("Benutzername bereits vergeben");
    }

    await this.tenancy.reconcile();
    const member = await this.tenancy.resolveMember(user.id);
    if (member !== null) {
      await this.db.update(invites).set({ redeemedByMemberId: member.id }).where(eq(invites.id, inviteId));
      try {
        await this.gateways.forMember(member.id);
      } catch (error: unknown) {
        logger.warn("invite_redeem_paperless_deferred", {
          member_id: member.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info("invite_redeemed", { invite_id: inviteId, member_id: member?.id ?? null });
    return user;
  }
}
