import { Injectable } from "@nestjs/common";

import type { Principal } from "../auth/principal.js";

export type DocumentAction = "read" | "write" | "delete";

/**
 * Decides which documents a principal may touch (ADR-009 §Access policy).
 *
 * Until tenancy exists (ADR-009, ADR-010 step 3) there is one household and
 * every member owns everything, so members are always allowed. The worker
 * service may only write (type fields). Step 3 replaces the member branch with
 * home-space membership and shares; callers and guards stay as they are.
 */
@Injectable()
export class PolicyService {
  // async on purpose: the tenancy version will look up spaces and shares.
  async canAccessDocument(
    principal: Principal,
    _docId: number,
    action: DocumentAction,
  ): Promise<boolean> {
    if (principal.kind === "member") return true;
    return action === "write" && principal.scopes.has("internal:type-fields-write");
  }
}
