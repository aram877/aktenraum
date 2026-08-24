import { inject, Injectable } from "@angular/core";
import {
  injectInfiniteQuery,
  injectMutation,
  injectQuery,
  QueryClient,
} from "@tanstack/angular-query-experimental";

import { ApiClient } from "./api";

export interface InboxItem {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  added: string | null;
  ai_correspondent: string | null;
  ai_document_type: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_confidence: number | null;
  low_confidence: boolean;
  ai_error_message: string | null;
}

export interface InboxList {
  results: InboxItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface BulkApproveResult {
  succeeded: number[];
  failed: { id: number; message: string }[];
}

export const INBOX_KEY = ["inbox"] as const;

export const BULK_APPROVE_CONCURRENCY = 4;

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, pump);
  await Promise.all(lanes);
  return results;
}

export function nextPageParam(lastPage: InboxList, allPages: InboxList[]): number | undefined {
  const loaded = allPages.reduce((n, p) => n + p.results.length, 0);
  if (loaded >= lastPage.total) return undefined;
  return lastPage.page + 1;
}

@Injectable({ providedIn: "root" })
export class InboxApi {
  private readonly api = inject(ApiClient);

  list(params: { page?: number; pageSize?: number; ordering?: string } = {}): Promise<InboxList> {
    const search = new URLSearchParams();
    search.set("page", String(params.page ?? 1));
    search.set("page_size", String(params.pageSize ?? 20));
    search.set("ordering", params.ordering ?? "-modified");
    return this.api.get<InboxList>(`/inbox/?${search.toString()}`);
  }

  approve(id: number): Promise<unknown> {
    return this.api.post(`/inbox/${id}/approve`, {});
  }

  reject(id: number): Promise<unknown> {
    return this.api.post(`/inbox/${id}/reject`, {});
  }

  detail(id: number): Promise<InboxDetail> {
    return this.api.get<InboxDetail>(`/inbox/${id}`);
  }

  approveWith(id: number, body?: InboxFieldUpdate): Promise<unknown> {
    return this.api.post(`/inbox/${id}/approve`, body ?? {});
  }
}

export function injectInboxDetail(id: () => number | null) {
  const api = inject(InboxApi);
  return injectQuery(() => ({
    queryKey: [...INBOX_KEY, "detail", id()],
    queryFn: () => api.detail(id() as number),
    enabled: id() !== null,
    staleTime: 30_000,
  }));
}

export function injectInboxList(params: { pageSize?: number } = {}) {
  const api = inject(InboxApi);
  const pageSize = params.pageSize ?? 50;
  return injectQuery(() => ({
    queryKey: [...INBOX_KEY, "list", 1, pageSize, "-modified"],
    queryFn: () => api.list({ page: 1, pageSize, ordering: "-modified" }),
    staleTime: 30_000,
  }));
}

export function injectApprove(id: () => number) {
  const api = inject(InboxApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (body?: InboxFieldUpdate) => api.approveWith(id(), body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  }));
}

export function injectReject(id: () => number) {
  const api = inject(InboxApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: () => api.reject(id()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  }));
}

export function injectInboxListInfinite(
  params: { pageSize?: number; ordering?: string } = {},
) {
  const api = inject(InboxApi);
  const pageSize = params.pageSize ?? 50;
  const ordering = params.ordering ?? "-modified";
  return injectInfiniteQuery(() => ({
    queryKey: [...INBOX_KEY, "list-infinite", pageSize, ordering],
    queryFn: ({ pageParam }: { pageParam: number }) =>
      api.list({ page: pageParam, pageSize, ordering }),
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  }));
}

export function injectBulkApprove() {
  const api = inject(InboxApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: async (ids: number[]): Promise<BulkApproveResult> => {
      const results = await runWithConcurrency(ids, BULK_APPROVE_CONCURRENCY, async (id) => {
        try {
          await api.approve(id);
          return { id, ok: true as const };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Fehler";
          return { id, ok: false as const, message };
        }
      });
      const succeeded: number[] = [];
      const failed: { id: number; message: string }[] = [];
      for (const r of results) {
        if (r.ok) succeeded.push(r.id);
        else failed.push({ id: r.id, message: r.message });
      }
      return { succeeded, failed };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
    },
  }));
}

export interface InboxDetail extends InboxItem {
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
  ai_backend: string | null;
  ai_model: string | null;
  ai_confidence_reason: string | null;
  content_excerpt: string;
  tags: string[];
  type_fields: Record<string, string> | null;
}

export type InboxFieldUpdate = Partial<{
  ai_document_type: string | null;
  ai_correspondent: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
}>;

export const FORM_FIELDS = [
  "ai_document_type",
  "ai_correspondent",
  "ai_title",
  "ai_issue_date",
  "ai_reference_numbers",
  "ai_suggested_tags",
  "ai_summary_de",
] as const;

export type FormField = (typeof FORM_FIELDS)[number];
export type FormState = Record<FormField, string>;

export const EMPTY_FORM: FormState = {
  ai_document_type: "",
  ai_correspondent: "",
  ai_title: "",
  ai_issue_date: "",
  ai_reference_numbers: "",
  ai_suggested_tags: "",
  ai_summary_de: "",
};

export function detailToForm(detail: InboxDetail): FormState {
  const out = { ...EMPTY_FORM };
  for (const field of FORM_FIELDS) out[field] = detail[field] ?? "";
  return out;
}

/**
 * Merge a freshly-fetched form state into the one on screen without
 * clobbering fields the user has edited. A field is overwritten only when
 * the user has not touched it since the last hydration — i.e. its current
 * value still equals what we last hydrated it to.
 */
export function mergeHydration(
  current: FormState,
  lastHydrated: FormState | null,
  next: FormState,
): FormState {
  if (lastHydrated === null) return next;
  const merged = { ...current };
  let changed = false;
  for (const field of FORM_FIELDS) {
    if (current[field] === lastHydrated[field] && current[field] !== next[field]) {
      merged[field] = next[field];
      changed = true;
    }
  }
  return changed ? merged : current;
}

export function buildDirtyPatch(form: FormState, detail: InboxDetail): InboxFieldUpdate {
  const out: InboxFieldUpdate = {};
  for (const field of FORM_FIELDS) {
    const value = form[field].trim();
    const original = (detail[field] ?? "").trim();
    if (value !== original) out[field] = value === "" ? null : value;
  }
  return out;
}

/**
 * Pick the neighbour to jump to after approving/rejecting the current doc.
 * `undefined` means "nothing left — go back to the review list".
 */
export function pickNeighbour(
  ids: readonly number[],
  currentId: number,
  direction: "next" | "prev",
): number | undefined {
  const remaining = ids.filter((d) => d !== currentId);
  if (remaining.length === 0) return undefined;
  const currentPos = ids.indexOf(currentId);
  if (currentPos === -1) {
    return direction === "next" ? remaining[0] : remaining[remaining.length - 1];
  }
  if (direction === "next") {
    return remaining.find((d) => ids.indexOf(d) > currentPos) ?? remaining[0];
  }
  const before = remaining.filter((d) => ids.indexOf(d) < currentPos);
  return before.length > 0 ? before[before.length - 1] : remaining[remaining.length - 1];
}
