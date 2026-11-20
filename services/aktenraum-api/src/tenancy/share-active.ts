import { sql } from "drizzle-orm";

import { documentShares } from "../db/schema.js";

/**
 * SQL predicate: the share has not expired. Always decided by the database
 * clock, never by comparing a stored timestamp with `Date.now()` (pg-mem's
 * `now()` is off by the local UTC offset, see CLAUDE.md).
 */
export const shareActive = sql`(${documentShares.expiresAt} IS NULL OR ${documentShares.expiresAt} > now())`;
