import { LIFECYCLE_TAGS } from "@aktenraum/core";

import type { QueryParams } from "./paperless.gateway.js";

// A document is "failed" when any of these is set. `ai-index-error` is
// auxiliary (not in LIFECYCLE_TAGS) but still means the pipeline stopped.
export const ERROR_TAGS = ["ai-error", "ai-propagation-error", "ai-index-error"] as const;

export const LIBRARY_STATUSES = ["error", "unprocessed", "approved", "done", "rejected"] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

const SINGLE_TAG_STATUS: Record<"approved" | "done" | "rejected", string> = {
  approved: "ai-approved",
  done: "ai-propagated",
  rejected: "ai-rejected",
};

export function isLibraryStatus(value: string): value is LibraryStatus {
  return (LIBRARY_STATUSES as readonly string[]).includes(value);
}

export function errorTagIds(nameToId: Record<string, number>): number[] {
  return ERROR_TAGS.map((name) => nameToId[name]).filter((id): id is number => id !== undefined);
}

/**
 * Paperless filters for a processing status. `noneIds` / `allIds` are merged
 * by the caller with the filters it already sets (ai-pending exclusion, user
 * tags). Returns null when the status cannot match anything because its tag
 * does not exist yet — the caller must return an empty page, not an
 * unfiltered one.
 */
export function statusFilter(
  status: LibraryStatus,
  nameToId: Record<string, number>,
): { params: QueryParams; noneIds: number[]; allIds: number[] } | null {
  if (status === "error") {
    const ids = errorTagIds(nameToId);
    if (ids.length === 0) return null;
    return { params: { tags__id__in: ids.join(",") }, noneIds: [], allIds: [] };
  }
  if (status === "unprocessed") {
    const ids = LIFECYCLE_TAGS.map((name) => nameToId[name]).filter(
      (id): id is number => id !== undefined,
    );
    return { params: {}, noneIds: ids, allIds: [] };
  }
  const tagId = nameToId[SINGLE_TAG_STATUS[status]];
  if (tagId === undefined) return null;
  return { params: {}, noneIds: [], allIds: [tagId] };
}
