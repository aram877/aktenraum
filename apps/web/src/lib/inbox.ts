import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type InboxItem = {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  ai_correspondent: string | null;
  ai_document_type: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_confidence: number | null;
  low_confidence: boolean;
  ai_error_message: string | null;
};

export type InboxDetail = InboxItem & {
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
  ai_backend: string | null;
  ai_model: string | null;
  ai_confidence_reason: string | null;
  content_excerpt: string;
  tags: string[];
};

export type InboxList = {
  results: InboxItem[];
  total: number;
  page: number;
  page_size: number;
};

export type InboxFieldUpdate = Partial<{
  ai_document_type: string | null;
  ai_correspondent: string | null;
  ai_title: string | null;
  ai_issue_date: string | null;
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
}>;

const INBOX_KEY = ["inbox"] as const;

async function fetchInboxList(
  params: { page?: number; pageSize?: number; ordering?: string } = {},
): Promise<InboxList> {
  const { data } = await api.get<InboxList>("/inbox/", {
    params: {
      page: params.page ?? 1,
      page_size: params.pageSize ?? 20,
      ordering: params.ordering ?? "-modified",
    },
  });
  return data;
}

async function fetchInboxDetail(id: number): Promise<InboxDetail> {
  const { data } = await api.get<InboxDetail>(`/inbox/${id}`);
  return data;
}

async function patchInbox(
  id: number,
  body: InboxFieldUpdate,
): Promise<InboxDetail> {
  const { data } = await api.patch<InboxDetail>(`/inbox/${id}`, body);
  return data;
}

async function approveInbox(
  id: number,
  body?: InboxFieldUpdate,
): Promise<InboxDetail> {
  const { data } = await api.post<InboxDetail>(
    `/inbox/${id}/approve`,
    body ?? {},
  );
  return data;
}

async function rejectInbox(id: number): Promise<InboxDetail> {
  const { data } = await api.post<InboxDetail>(`/inbox/${id}/reject`);
  return data;
}

export function useInboxList(params: { page?: number; pageSize?: number; ordering?: string } = {}) {
  return useQuery<InboxList, AxiosError>({
    queryKey: [...INBOX_KEY, "list", params.page ?? 1, params.pageSize ?? 20, params.ordering ?? "-modified"],
    queryFn: () => fetchInboxList(params),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

// Same data as useInboxList, paged via load-more. Used by the review tab,
// where the user triages top-to-bottom and multi-select must span chunks.
export function useInboxListInfinite(
  params: { pageSize?: number; ordering?: string } = {},
) {
  const pageSize = params.pageSize ?? 50;
  const ordering = params.ordering ?? "-modified";
  return useInfiniteQuery<InboxList, AxiosError>({
    queryKey: [...INBOX_KEY, "list-infinite", pageSize, ordering],
    queryFn: ({ pageParam }) =>
      fetchInboxList({ page: pageParam as number, pageSize, ordering }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.results.length, 0);
      if (loaded >= lastPage.total) return undefined;
      return lastPage.page + 1;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useInboxDetail(id: number | null) {
  return useQuery<InboxDetail, AxiosError>({
    queryKey: [...INBOX_KEY, "detail", id],
    queryFn: () => fetchInboxDetail(id as number),
    enabled: id !== null,
    staleTime: 0,
  });
}

export function useInboxPatch(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InboxFieldUpdate) => patchInbox(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...INBOX_KEY, "detail", id] });
      qc.invalidateQueries({ queryKey: [...INBOX_KEY, "list"] });
    },
  });
}

export function useApprove(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: InboxFieldUpdate) => approveInbox(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INBOX_KEY });
    },
  });
}

export function useReject(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rejectInbox(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INBOX_KEY });
    },
  });
}

export type BulkApproveResult = {
  succeeded: number[];
  failed: { id: number; message: string }[];
};

// Max parallel approve POSTs we'll send. Each approve = 3 round trips
// against Paperless (read tags + verify + PATCH), so 50 inbox docs at
// unbounded concurrency = 150 simultaneous requests, easily enough to
// saturate Paperless's gunicorn workers and trip 409s from concurrent
// PATCHes. Four is the empirical sweet spot — high enough to feel
// instant for 10-20 docs, low enough that Paperless never queues.
const _BULK_APPROVE_CONCURRENCY = 4;

async function _runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) continue;
      results[idx] = await worker(item);
    }
  }
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    pump,
  );
  await Promise.all(lanes);
  return results;
}

export function useBulkApprove() {
  const qc = useQueryClient();
  return useMutation<BulkApproveResult, AxiosError, number[]>({
    mutationFn: async (ids) => {
      const results = await _runWithConcurrency(
        ids,
        _BULK_APPROVE_CONCURRENCY,
        async (id) => {
          try {
            await approveInbox(id);
            return { id, ok: true as const };
          } catch (err) {
            const message = (err as AxiosError | Error)?.message ?? "Fehler";
            return { id, ok: false as const, message };
          }
        },
      );
      const succeeded: number[] = [];
      const failed: { id: number; message: string }[] = [];
      for (const r of results) {
        if (r.ok) succeeded.push(r.id);
        else failed.push({ id: r.id, message: r.message });
      }
      return { succeeded, failed };
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: INBOX_KEY });
    },
  });
}
