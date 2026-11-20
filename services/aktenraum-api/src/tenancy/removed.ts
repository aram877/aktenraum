import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * A member is removed when `member_removals` has a row for it
 * (tenancy-member-removal). Every member-facing lookup — member list,
 * directory, space and share pickers, the household member count — filters
 * with this. Uncorrelated `NOT IN` so pg-mem runs it too.
 */
export function notRemoved(memberId: AnyPgColumn): SQL {
  return sql`${memberId} NOT IN (SELECT "member_id" FROM "member_removals")`;
}
