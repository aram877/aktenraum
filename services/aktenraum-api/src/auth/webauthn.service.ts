import { randomBytes } from "node:crypto";

import { logger } from "@aktenraum/core";
import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Request } from "express";

import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import {
  memberRemovals,
  passkeys,
  webauthnChallenges,
  webauthnUsers,
  type PasskeyDeviceType,
  type WebauthnCeremonyKind,
  type WebauthnPurpose,
} from "../db/schema.js";
import { providerOf } from "./aaguids.js";

/**
 * WebAuthn ceremonies (auth-passkeys design §2, §3). Every flow is begin →
 * finish. Begin checks the origin against WEBAUTHN_ORIGINS, generates options
 * and stores a single-use challenge row (5 minutes); finish claims that row
 * atomically before verifying, so a response can't be retried or replayed.
 */

export const RP_NAME = "aktenraum";
/** The one answer to every failed passkey ceremony — no oracle. */
export const PASSKEY_REJECTED = "Passkey nicht akzeptiert";
export const ORIGIN_REFUSED = "Passkeys sind auf dieser Adresse nicht eingerichtet";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export interface Ceremony<T> {
  ceremony: string;
  options: T;
}

export type ChallengeRow = typeof webauthnChallenges.$inferSelect;

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  aaguid: string;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  prf: boolean;
  rpId: string;
}

export interface PasskeyRecord {
  id: number;
  memberId: number;
  name: string;
  rpId: string;
}

export interface PasskeyView {
  id: number;
  name: string;
  provider: string;
  synced: boolean;
  rp_id: string;
  created_at: string;
  last_used_at: string | null;
  prf: boolean;
}

interface RegistrationContext {
  purpose: Extract<WebauthnPurpose, "enrol" | "add" | "invite" | "setup">;
  userHandle: string;
  username: string;
  memberId?: number | null;
  sessionId?: number | null;
  inviteId?: number | null;
  setupTokenId?: number | null;
}

interface AuthenticationContext {
  purpose: Extract<WebauthnPurpose, "login" | "step_up">;
  memberId?: number | null;
  sessionId?: number | null;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

@Injectable()
export class WebauthnService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  /** The configured origins, normalised (no trailing slash). */
  origins(): string[] {
    return this.settings.WEBAUTHN_ORIGINS.map((origin) => origin.replace(/\/$/, ""));
  }

  /**
   * The request's `Origin` if it is configured, else 400 — before any
   * challenge exists. The RP ID is the origin's host name (never a header).
   */
  originOf(request: Request): { origin: string; rpId: string } {
    const header = request.headers.origin;
    const origin = typeof header === "string" ? header.replace(/\/$/, "") : "";
    if (origin === "" || !this.origins().includes(origin)) {
      logger.warn("webauthn_origin_refused", { origin: origin || null });
      throw new BadRequestException(ORIGIN_REFUSED);
    }
    return { origin, rpId: new URL(origin).hostname };
  }

  // -------------------------------------------------------------------------
  // User handles
  // -------------------------------------------------------------------------

  /** A fresh random WebAuthn user.id (64 bytes, base64url) — never the member id. */
  newUserHandle(): string {
    return randomBytes(64).toString("base64url");
  }

  async userHandleOf(memberId: number): Promise<string | null> {
    const rows = await this.db
      .select({ handle: webauthnUsers.userHandle })
      .from(webauthnUsers)
      .where(eq(webauthnUsers.memberId, memberId))
      .limit(1);
    return rows[0]?.handle ?? null;
  }

  async ensureUserHandle(memberId: number, handle?: string): Promise<string> {
    const existing = await this.userHandleOf(memberId);
    if (existing !== null) return existing;
    const created = handle ?? this.newUserHandle();
    await this.db.insert(webauthnUsers).values({ memberId, userHandle: created }).onConflictDoNothing();
    return (await this.userHandleOf(memberId)) ?? created;
  }

  // -------------------------------------------------------------------------
  // Begin
  // -------------------------------------------------------------------------

  private async store(
    kind: WebauthnCeremonyKind,
    challenge: string,
    target: { origin: string; rpId: string },
    fields: Partial<typeof webauthnChallenges.$inferInsert> & { purpose: WebauthnPurpose },
  ): Promise<string> {
    const ceremony = randomBytes(32).toString("base64url");
    await this.db.insert(webauthnChallenges).values({
      ...fields,
      ceremony,
      challenge,
      kind,
      rpId: target.rpId,
      origin: target.origin,
      expiresAt: sql`now() + interval '5 minutes'` as unknown as string,
    });
    return ceremony;
  }

  async beginRegistration(
    target: { origin: string; rpId: string },
    context: RegistrationContext,
  ): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    const exclude = context.memberId == null ? [] : await this.activeCredentials(context.memberId, target.rpId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: target.rpId,
      userName: context.username,
      userDisplayName: context.username,
      userID: Buffer.from(context.userHandle, "base64url"),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: exclude,
      // Only the PRF extension's availability is recorded (design: no key material).
      extensions: { prf: {} } as never,
    });
    const ceremony = await this.store("register", options.challenge, target, {
      purpose: context.purpose,
      memberId: context.memberId ?? null,
      sessionId: context.sessionId ?? null,
      inviteId: context.inviteId ?? null,
      setupTokenId: context.setupTokenId ?? null,
      username: context.username.slice(0, 64),
      userHandle: context.userHandle,
    });
    return { ceremony, options };
  }

  async beginAuthentication(
    target: { origin: string; rpId: string },
    context: AuthenticationContext,
  ): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
    const allow = context.memberId == null ? [] : await this.activeCredentials(context.memberId, target.rpId);
    const options = await generateAuthenticationOptions({
      rpID: target.rpId,
      userVerification: "required",
      allowCredentials: allow,
    });
    const ceremony = await this.store(context.purpose === "login" ? "login" : "step_up", options.challenge, target, {
      purpose: context.purpose,
      memberId: context.memberId ?? null,
      sessionId: context.sessionId ?? null,
    });
    return { ceremony, options };
  }

  // -------------------------------------------------------------------------
  // Finish
  // -------------------------------------------------------------------------

  /** Spends the ceremony (even if verification then fails). null = unknown, used, expired or another kind. */
  async claim(ceremony: string, kind: WebauthnCeremonyKind): Promise<ChallengeRow | null> {
    if (typeof ceremony !== "string" || ceremony.length === 0 || ceremony.length > 43) return null;
    const rows = await this.db
      .update(webauthnChallenges)
      .set({ usedAt: sql`now()` as unknown as string })
      .where(
        and(
          eq(webauthnChallenges.ceremony, ceremony),
          eq(webauthnChallenges.kind, kind),
          isNull(webauthnChallenges.usedAt),
          sql`${webauthnChallenges.expiresAt} > now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Verifies a registration against its claimed ceremony; throws 401 on any mismatch. */
  async verifyRegistration(row: ChallengeRow, response: RegistrationResponseJSON): Promise<VerifiedRegistration> {
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: row.challenge,
        expectedOrigin: row.origin,
        expectedRPID: row.rpId,
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error("not verified");
      info = result.registrationInfo;
    } catch (error: unknown) {
      logger.warn("webauthn_registration_rejected", {
        purpose: row.purpose,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new UnauthorizedException(PASSKEY_REJECTED);
    }
    const extensions = (response.clientExtensionResults ?? {}) as { prf?: { enabled?: boolean } };
    const transports = info.credential.transports ?? response.response.transports ?? [];
    return {
      credentialId: info.credential.id,
      publicKey: b64(info.credential.publicKey),
      counter: info.credential.counter,
      transports: transports.length > 0 ? transports.join(",").slice(0, 128) : null,
      aaguid: info.aaguid,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      prf: extensions.prf?.enabled === true,
      rpId: row.rpId,
    };
  }

  /**
   * Verifies an assertion: an active passkey of a member that isn't removed,
   * the stored user handle, signature, UV and counter. Updates sign count and
   * last use. Returns the passkey; throws 401 with one message otherwise.
   */
  async verifyAuthentication(row: ChallengeRow, response: AuthenticationResponseJSON): Promise<PasskeyRecord> {
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const rows = await this.db
      .select({
        id: passkeys.id,
        memberId: passkeys.memberId,
        name: passkeys.name,
        publicKey: passkeys.publicKey,
        signCount: passkeys.signCount,
        transports: passkeys.transports,
        rpId: passkeys.rpId,
        userHandle: webauthnUsers.userHandle,
      })
      .from(passkeys)
      .innerJoin(webauthnUsers, eq(webauthnUsers.memberId, passkeys.memberId))
      .where(
        and(
          eq(passkeys.credentialId, credentialId),
          isNull(passkeys.removedAt),
          sql`${passkeys.memberId} NOT IN (SELECT ${memberRemovals.memberId} FROM ${memberRemovals})`,
        ),
      )
      .limit(1);
    const found = rows[0];
    const reject = (reason: string, extra: Record<string, unknown> = {}): never => {
      logger.warn("webauthn_assertion_rejected", { purpose: row.purpose, reason, ...extra });
      throw new UnauthorizedException(PASSKEY_REJECTED);
    };
    if (found === undefined) return reject("unknown_credential");
    if (found.rpId !== row.rpId) return reject("rp_id_mismatch");
    if (response.response?.userHandle !== found.userHandle) return reject("user_handle_mismatch", { passkey_id: found.id });

    let newCounter: number;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: row.challenge,
        expectedOrigin: row.origin,
        expectedRPID: row.rpId,
        requireUserVerification: true,
        credential: {
          id: credentialId,
          publicKey: Buffer.from(found.publicKey, "base64url"),
          counter: Number(found.signCount),
          transports: (found.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
        },
      });
      if (!result.verified) return reject("signature", { passkey_id: found.id });
      newCounter = result.authenticationInfo.newCounter;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A cloned authenticator shows up as a counter that goes backwards.
      if (/counter/i.test(message)) {
        logger.warn("passkey_counter_regression", { passkey_id: found.id, member_id: found.memberId });
      }
      return reject("verification", { passkey_id: found.id, error: message });
    }
    await this.db
      .update(passkeys)
      .set({ signCount: newCounter, lastUsedAt: sql`now()` as unknown as string })
      .where(eq(passkeys.id, found.id));
    return { id: found.id, memberId: found.memberId, name: found.name, rpId: found.rpId };
  }

  // -------------------------------------------------------------------------
  // Passkeys
  // -------------------------------------------------------------------------

  private async activeCredentials(memberId: number, rpId: string): Promise<{ id: string; transports?: AuthenticatorTransportFuture[] }[]> {
    const rows = await this.db
      .select({ id: passkeys.credentialId, transports: passkeys.transports })
      .from(passkeys)
      .where(and(eq(passkeys.memberId, memberId), eq(passkeys.rpId, rpId), isNull(passkeys.removedAt)));
    return rows.map((row) => ({
      id: row.id,
      ...(row.transports ? { transports: row.transports.split(",") as AuthenticatorTransportFuture[] } : {}),
    }));
  }

  async activeCount(memberId: number): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(passkeys)
      .where(and(eq(passkeys.memberId, memberId), isNull(passkeys.removedAt)));
    return Number(row?.count ?? 0);
  }

  /** Stores a verified credential; 409 when the credential id is already known. */
  async storePasskey(memberId: number, verified: VerifiedRegistration, name?: string | null): Promise<PasskeyRecord> {
    const existing = await this.db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialId, verified.credentialId))
      .limit(1);
    if (existing.length > 0) throw new ConflictException("Dieser Passkey ist bereits registriert");
    const label = name?.trim() || `${providerOf(verified.aaguid)} · ${new Date().toLocaleDateString("de-DE")}`;
    const [row] = await this.db
      .insert(passkeys)
      .values({
        memberId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: verified.counter,
        transports: verified.transports,
        aaguid: verified.aaguid,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        prfEnabled: verified.prf,
        rpId: verified.rpId,
        name: label.slice(0, 64),
      })
      .returning({ id: passkeys.id, memberId: passkeys.memberId, name: passkeys.name, rpId: passkeys.rpId });
    return row!;
  }

  async list(memberId: number): Promise<PasskeyView[]> {
    const rows = await this.db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.memberId, memberId), isNull(passkeys.removedAt)))
      .orderBy(asc(passkeys.createdAt), asc(passkeys.id));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: providerOf(row.aaguid),
      synced: row.deviceType === "multiDevice",
      rp_id: row.rpId,
      created_at: iso(row.createdAt)!,
      last_used_at: iso(row.lastUsedAt),
      prf: row.prfEnabled,
    }));
  }

  /** null = not one of the member's active passkeys. */
  async rename(memberId: number, id: number, name: string): Promise<PasskeyRecord | null> {
    const rows = await this.db
      .update(passkeys)
      .set({ name: name.trim().slice(0, 64) })
      .where(and(eq(passkeys.id, id), eq(passkeys.memberId, memberId), isNull(passkeys.removedAt)))
      .returning({ id: passkeys.id, memberId: passkeys.memberId, name: passkeys.name, rpId: passkeys.rpId });
    return rows[0] ?? null;
  }

  /** "missing" = not the member's; "last" = refusing to remove the only active one. */
  async remove(memberId: number, id: number): Promise<PasskeyRecord | "missing" | "last"> {
    const own = await this.db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.memberId, memberId), isNull(passkeys.removedAt)))
      .limit(1);
    if (own.length === 0) return "missing";
    // "Another active passkey exists" is part of the update itself, so the
    // last one can't slip through between a count and the write. Uncorrelated
    // IN so pg-mem runs it too.
    const rows = await this.db
      .update(passkeys)
      .set({ removedAt: sql`now()` as unknown as string })
      .where(
        and(
          eq(passkeys.id, id),
          isNull(passkeys.removedAt),
          sql`${memberId} IN (SELECT "member_id" FROM "passkeys" WHERE "removed_at" IS NULL AND "id" <> ${id})`,
        ),
      )
      .returning({ id: passkeys.id, memberId: passkeys.memberId, name: passkeys.name, rpId: passkeys.rpId });
    return rows[0] ?? "last";
  }
}
