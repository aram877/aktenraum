import { Inject, Injectable } from "@nestjs/common";

import type { Principal } from "../auth/principal.js";
import type { SpaceRole } from "../db/schema.js";
import { TenancyService, type TenancyLookup } from "../tenancy/tenancy.service.js";

export type DocumentAction = "read" | "write" | "delete";

const SPACE_ROLE_ACTIONS: Readonly<Record<SpaceRole, ReadonlySet<DocumentAction>>> = {
  viewer: new Set<DocumentAction>(["read"]),
  editor: new Set<DocumentAction>(["read", "write"]),
  owner: new Set<DocumentAction>(["read", "write", "delete"]),
};

export function spaceRoleAllows(role: SpaceRole, action: DocumentAction): boolean {
  return SPACE_ROLE_ACTIONS[role].has(action);
}

/**
 * Decides which documents a principal may touch (ADR-009 §Access policy).
 *
 * A member may act on a document when its home space (`document_spaces`) is one
 * of the member's spaces and the space role permits the action. A document
 * without a home space yet (it arrived between deploy and assignment) is
 * visible to the household admin only. Shares join here with `tenancy-sharing`.
 * Service principals get exactly what their scopes grant: the worker may only
 * write (type fields).
 */
@Injectable()
export class PolicyService {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyLookup) {}

  async canAccessDocument(
    principal: Principal,
    docId: number,
    action: DocumentAction,
  ): Promise<boolean> {
    if (principal.kind === "service") {
      return action === "write" && principal.scopes.has("internal:type-fields-write");
    }
    const access = await this.tenancy.documentAccess(docId, principal.memberId);
    if (!access.assigned) return principal.householdRole === "admin";
    return access.role !== null && spaceRoleAllows(access.role, action);
  }
}
