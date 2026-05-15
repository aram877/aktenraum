import {
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
};

export type InboxDetail = InboxItem & {
  ai_reference_numbers: string | null;
  ai_suggested_tags: string | null;
  ai_summary_de: string | null;
  ai_backend: string | null;
  ai_model: string | null;
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
