import { logger } from "@aktenraum/core";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import { members, passwordRetirements, users } from "../db/schema.js";
import type { SessionAuthMethod } from "../db/schema.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import type { Request, Response } from "express";

import { NO_PASSWORD, hashPassword, verifyPassword } from "./passwords.js";
import { SessionService } from "./session.service.js";

let timingDummyHash: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  timingDummyHash ??= hashPassword("aktenraum-timing-equaliser");
  return timingDummyHash;
}

export interface AuthUser {
  id: number;
  username: string;
  passwordHash: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly tenancy: TenancyService,
    private readonly sessions: SessionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrapUserIfEmpty();
  }

  async bootstrapUserIfEmpty(): Promise<void> {
    const username = this.settings.BOOTSTRAP_USERNAME;
    const password = this.settings.BOOTSTRAP_PASSWORD;
    if (!username) {
      logger.info("bootstrap_skipped_no_creds");
      return;
    }
    const existing = await this.db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      logger.info("bootstrap_skipped_user_exists");
      return;
    }
    // Without BOOTSTRAP_PASSWORD the admin is passwordless and enrols through
    // a setup link (task setup-link); with it, a password member who must enrol.
    await this.db.insert(users).values({
      username,
      passwordHash: password ? await hashPassword(password) : NO_PASSWORD,
    });
    logger.info("bootstrap_user_created", { username, passwordless: !password });
  }

  async findByUsername(username: string): Promise<AuthUser | null> {
    const rows = await this.db
      .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: number): Promise<AuthUser | null> {
    const rows = await this.db
      .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async authenticate(username: string, password: string): Promise<AuthUser | null> {
    const user = await this.findByUsername(username);
    if (user === null) {
      await verifyPassword(password, await dummyHash());
      return null;
    }
    if (!(await verifyPassword(password, user.passwordHash))) return null;
    // Checked after the bcrypt compare and answered like a wrong password, so
    // neither timing nor answer tells that the username belongs to a removed
    // member (tenancy-member-removal). The controller counts it as a failure.
    if (await this.tenancy.isUserRemoved(user.id)) return null;
    // Retired passwords (auth-passkeys §5): refused exactly like a wrong one.
    if (await this.isPasswordRetired(user.id)) return null;
    return user;
  }

  async isPasswordRetired(userId: number): Promise<boolean> {
    const rows = await this.db
      .select({ memberId: passwordRetirements.memberId })
      .from(passwordRetirements)
      .innerJoin(members, eq(members.id, passwordRetirements.memberId))
      .where(eq(members.userId, userId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Creates a server-side session for `user` and sets its cookie — login and
   * invite redemption share it. Returns the member and session ids, or null
   * when the user is not (or no longer) a household member.
   */
  async issueSession(
    response: Response,
    request: Request,
    user: AuthUser,
    method: SessionAuthMethod,
  ): Promise<{ memberId: number; sessionId: number } | null> {
    const member = await this.tenancy.resolveMember(user.id);
    if (member === null) return null;
    const sessionId = await this.sessions.issue(response, request, member, method);
    return { memberId: member.id, sessionId };
  }
}
