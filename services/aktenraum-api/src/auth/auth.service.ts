import { logger } from "@aktenraum/core";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./passwords.js";

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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrapUserIfEmpty();
  }

  async bootstrapUserIfEmpty(): Promise<void> {
    const username = this.settings.BOOTSTRAP_USERNAME;
    const password = this.settings.BOOTSTRAP_PASSWORD;
    if (!username || !password) {
      logger.info("bootstrap_skipped_no_creds");
      return;
    }
    const existing = await this.db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      logger.info("bootstrap_skipped_user_exists");
      return;
    }
    await this.db.insert(users).values({
      username,
      passwordHash: await hashPassword(password),
    });
    logger.info("bootstrap_user_created", { username });
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
    if (user === null) return null;
    if (!(await verifyPassword(password, user.passwordHash))) return null;
    return user;
  }

  async setPassword(userId: number, newPassword: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, userId));
  }
}
