import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type { Principal } from "../auth/principal.js";
import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import { memberPaperlessTokens, spaceMembers } from "../db/schema.js";
import { PaperlessAuthError } from "../paperless/errors.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import {
  PAPERLESS_GATEWAY_FACTORY,
  PaperlessGatewayProvider,
  type PaperlessGatewayFactory,
} from "../paperless/paperless.module.js";
import { memberUsername, provisionMemberUser, syncSpaceMembership } from "./paperless-mirror.js";
import { TokenVault, TokenVaultError } from "./token-vault.js";

/**
 * The Paperless gateway a request must use (ADR-009 / ADR-010 §8): a member's
 * requests go out with that member's own Paperless token, so Paperless
 * enforces the same isolation as `PolicyService`; service principals (the
 * worker) get the service gateway.
 *
 * Member tokens are minted by aktenraum on first use (provisioning the
 * member's Paperless user and group memberships on the way), stored sealed in
 * `member_paperless_tokens`, and are disposable: an undecryptable row or a 401
 * from Paperless re-mints once and retries the call once.
 */
@Injectable()
export class MemberGateways {
  private readonly vault: TokenVault;
  private readonly cache = new Map<number, PaperlessGateway>();
  private readonly minting = new Map<number, Promise<string>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly paperless: PaperlessGatewayProvider,
    @Inject(PAPERLESS_GATEWAY_FACTORY) private readonly factory: PaperlessGatewayFactory,
    @Inject(SETTINGS) settings: Settings,
  ) {
    this.vault = new TokenVault(settings.AKTENRAUM_SECRET_KEY);
  }

  async forPrincipal(principal: Principal): Promise<PaperlessGateway> {
    if (principal.kind === "service") return this.paperless.service();
    return this.forMember(principal.memberId);
  }

  async forMember(memberId: number): Promise<PaperlessGateway> {
    const cached = this.cache.get(memberId);
    if (cached !== undefined) return cached;
    this.paperless.service(); // 503 when Paperless isn't configured, before any work
    const token = (await this.storedToken(memberId)) ?? (await this.mint(memberId));
    const gateway = this.withRemint(memberId, this.factory(token));
    this.cache.set(memberId, gateway);
    return gateway;
  }

  /** Drops cached gateways, e.g. after the member's Paperless user changed. */
  forget(memberId: number): void {
    this.cache.delete(memberId);
  }

  private async storedToken(memberId: number): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(memberPaperlessTokens)
      .where(eq(memberPaperlessTokens.memberId, memberId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    try {
      return this.vault.open(row);
    } catch (error: unknown) {
      if (!(error instanceof TokenVaultError)) throw error;
      logger.warn("member_token_unreadable_reminting", { member_id: memberId, reason: error.message });
      return null;
    }
  }

  /** One mint at a time per member; concurrent first requests share it. */
  async mint(memberId: number): Promise<string> {
    const running = this.minting.get(memberId);
    if (running !== undefined) return running;
    const work = this.doMint(memberId).finally(() => this.minting.delete(memberId));
    this.minting.set(memberId, work);
    return work;
  }

  private async doMint(memberId: number): Promise<string> {
    const service = this.paperless.service();
    const { paperlessUserId } = await provisionMemberUser(this.db, service, memberId);
    const memberSpaces = await this.db
      .select({ spaceId: spaceMembers.spaceId })
      .from(spaceMembers)
      .where(eq(spaceMembers.memberId, memberId));
    for (const { spaceId } of memberSpaces) await syncSpaceMembership(this.db, service, spaceId);

    const token = await service.mintUserToken(paperlessUserId, memberUsername(memberId));
    const sealed = this.vault.seal(token);
    await this.db
      .insert(memberPaperlessTokens)
      .values({ memberId, ...sealed })
      .onConflictDoUpdate({
        target: memberPaperlessTokens.memberId,
        set: { ...sealed, createdAt: new Date().toISOString() },
      });
    logger.info("member_token_minted", { member_id: memberId });
    return token;
  }

  /**
   * Wraps a member gateway so a 401 (token no longer valid, e.g. after a
   * Paperless database restore) re-mints once and retries the call once. A 403
   * is a real permission answer and is passed through untouched.
   */
  private withRemint(memberId: number, gateway: PaperlessGateway): PaperlessGateway {
    return new Proxy(gateway, {
      get: (target, prop, receiver) => {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!(result instanceof Promise)) return result;
          return result.catch(async (error: unknown) => {
            if (!(error instanceof PaperlessAuthError) || error.status !== 401) throw error;
            logger.warn("member_token_rejected_reminting", { member_id: memberId });
            this.cache.delete(memberId);
            const fresh = this.factory(await this.mint(memberId));
            this.cache.set(memberId, this.withRemint(memberId, fresh));
            const retry = Reflect.get(fresh, prop) as (...a: unknown[]) => unknown;
            return retry.apply(fresh, args);
          });
        };
      },
    });
  }
}
