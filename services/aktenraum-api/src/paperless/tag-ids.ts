import type { PaperlessDocument } from "./paperless.gateway.js";

export function collectTagIds(docs: Iterable<PaperlessDocument>): number[] {
  const ids = new Set<number>();
  for (const doc of docs) {
    for (const tid of (doc.tags as number[] | undefined) ?? []) ids.add(tid);
  }
  return [...ids];
}
