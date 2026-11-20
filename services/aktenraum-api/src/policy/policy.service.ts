import { Inject, Injectable } from "@nestjs/common";

import type { Principal } from "../auth/principal.js";
import type { ShareAccessKindValue, ShareRole, SpaceRole } from "../db/schema.js";
import { TenancyService, type TenancyLookup } from "../tenancy/tenancy.service.js";

/**
 * - `write` = change the document's state (approve, reject, reprocess, star…)
 * - `edit-fields` = correct its AI fields and type fields
 * - `move` = take it out of its current space, `share` = manage its shares
 */
export type DocumentAction = "read" | "write" | "edit-fields" | "delete" | "move" | "share";

const SPACE_ROLE_ACTIONS: Readonly<Record<SpaceRole, ReadonlySet<DocumentAction>>> = {
  viewer: new Set<DocumentAction>(["read"]),
  editor: new Set<DocumentAction>(["read", "write", "edit-fields"]),
  owner: new Set<DocumentAction>(["read", "write", "edit-fields", "delete", "move", "share"]),
};

/** Shares are narrower than space roles: never write, delete, move or re-share (ADR-009). */
const SHARE_ROLE_ACTIONS: Readonly<Record<ShareRole, ReadonlySet<DocumentAction>>> = {
  viewer: new Set<DocumentAction>(["read"]),
  editor: new Set<DocumentAction>(["read", "edit-fields"]),
};

/** The household admin on a document without a home space: everything but sharing. */
const UNASSIGNED_ADMIN_ACTIONS: ReadonlySet<DocumentAction> = new Set<DocumentAction>([
  "read",
  "write",
  "edit-fields",
  "delete",
  "move",
]);

export function spaceRoleAllows(role: SpaceRole, action: DocumentAction): boolean {
  return SPACE_ROLE_ACTIONS[role].has(action);
}

export function shareRoleAllows(role: ShareRole, action: DocumentAction): boolean {
  return SHARE_ROLE_ACTIONS[role].has(action);
}

/** How a member reaches a document, for the detail payloads (`access: {via, role}`). */
export type DocumentAccessInfo =
  | { via: "space"; role: SpaceRole }
  | { via: "share"; role: ShareRole }
  | { via: "admin"; role: "admin" };

/**
 * Decides which documents a principal may touch (ADR-009 §Access policy).
 *
 * A member may act on a document when its home space (`document_spaces`) is one
 * of the member's spaces and the space role permits the action, or, failing
 * that, when an active share on the document permits it. A space role always
 * wins over a share. A document without a home space yet is visible to the
 * household admin only. Service principals get exactly what their scopes
 * grant: the worker may edit type fields and read the home space of a
 * document, nothing else.
 */
@Injectable()
export class PolicyService {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyLookup) {}

  async canAccessDocument(
    principal: Principal,
    docId: number,
    action: DocumentAction,
  ): Promise<boolean> {
    return this.authorizeDocument(principal, docId, action);
  }

  /**
   * `canAccessDocument`, plus the share access audit: when `accessKind` is
   * given and the member gets in through a share, the access is recorded
   * (best effort, deduplicated per hour by the tenancy service).
   */
  async authorizeDocument(
    principal: Principal,
    docId: number,
    action: DocumentAction,
    accessKind?: ShareAccessKindValue,
  ): Promise<boolean> {
    if (principal.kind === "service") {
      if (action === "edit-fields") return principal.scopes.has("internal:type-fields-write");
      if (action === "read") return principal.scopes.has("internal:tenancy-read");
      return false;
    }
    const info = await this.accessOf(principal, docId);
    if (info === null) return false;
    if (info.via === "admin") return UNASSIGNED_ADMIN_ACTIONS.has(action);
    if (info.via === "space") return spaceRoleAllows(info.role, action);
    const allowed = shareRoleAllows(info.role, action);
    if (allowed && accessKind !== undefined) {
      await this.tenancy.recordShareAccess?.(docId, principal.memberId, accessKind);
    }
    return allowed;
  }

  /** The member's way to a document, or null when they have none. */
  async accessOf(principal: Principal, docId: number): Promise<DocumentAccessInfo | null> {
    if (principal.kind !== "member") return null;
    const access = await this.tenancy.documentAccess(docId, principal.memberId);
    if (!access.assigned) return principal.householdRole === "admin" ? { via: "admin", role: "admin" } : null;
    if (access.role !== null) return { via: "space", role: access.role };
    if (access.share !== null) return { via: "share", role: access.share };
    return null;
  }
}
