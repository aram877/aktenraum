import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type TrashItem = {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  deleted_at: string | null;
  correspondent: string | null;
  document_type: string | null;
  ai_correspondent: string | null;
  ai_document_type: string | null;
  ai_summary_de: string | null;
};

export type TrashList = {
  results: TrashItem[];
  total: number;
  page: number;
  page_size: number;
};

export type EmptyTrashResponse = {
  emptied: number;
};

const TRASH_KEY = ["trash"] as const;

// Mirrors Paperless's default PAPERLESS_EMPTY_TRASH_DELAY. We do not
// fetch the actual value because it would require a new authenticated
// endpoint on aktenraum-api and the upside is purely cosmetic — being
// off by a few days never causes the user to lose data.
const DEFAULT_TRASH_DELAY_DAYS = 30;

async function fetchTrashList(
  params: { page?: number; pageSize?: number; ordering?: string } = {},
): Promise<TrashList> {
  const { data } = await api.get<TrashList>("/trash/", {
    params: {
      page: params.page ?? 1,
      page_size: params.pageSize ?? 20,
      ordering: params.ordering ?? "deleted_at",
    },
  });
  return data;
}

async function restoreFromTrash(id: number): Promise<void> {
  await api.post(`/trash/${id}/restore`);
}

async function deleteForever(id: number): Promise<void> {
  await api.post(`/trash/${id}/delete`);
}

async function emptyTrashRequest(): Promise<EmptyTrashResponse> {
  const { data } = await api.post<EmptyTrashResponse>("/trash/empty");
  return data;
}

export function useTrashList(
  params: { page?: number; pageSize?: number; ordering?: string } = {},
) {
  return useQuery<TrashList, AxiosError>({
    queryKey: [
      ...TRASH_KEY,
      "list",
      params.page ?? 1,
      params.pageSize ?? 20,
      params.ordering ?? "deleted_at",
    ],
    queryFn: () => fetchTrashList(params),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

// Lightweight count query for the nav badge — page_size=1 keeps the
// response tiny while still exposing `total`. Same 30 s cadence as
// the existing in-flight pill so the badge doesn't fan out a second
// polling timer.
export function useTrashCount() {
  return useQuery<TrashList, AxiosError>({
    queryKey: [...TRASH_KEY, "count"],
    queryFn: () => fetchTrashList({ pageSize: 1 }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

// Every trash mutation can ripple into library / inbox / in-flight /
// per-doc preview state, so we invalidate the union. Cheaper than
// computing precisely which views are affected on each action.
function invalidateRelated(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: TRASH_KEY });
  qc.invalidateQueries({ queryKey: ["library"] });
  qc.invalidateQueries({ queryKey: ["inbox"] });
  qc.invalidateQueries({ queryKey: ["in-flight"] });
  qc.invalidateQueries({ queryKey: ["document"] });
}

export function useRestoreFromTrash() {
  const qc = useQueryClient();
  return useMutation<void, AxiosError, number>({
    mutationFn: restoreFromTrash,
    onSuccess: () => invalidateRelated(qc),
  });
}

export function useDeleteForever() {
  const qc = useQueryClient();
  return useMutation<void, AxiosError, number>({
    mutationFn: deleteForever,
    onSuccess: () => invalidateRelated(qc),
  });
}

export function useEmptyTrash() {
  const qc = useQueryClient();
  return useMutation<EmptyTrashResponse, AxiosError, void>({
    mutationFn: emptyTrashRequest,
    onSuccess: () => invalidateRelated(qc),
  });
}

/** Days remaining until Paperless's auto-empty fires for a given
 * trash row. Returns null if `deleted_at` is missing or unparseable.
 * Always >= 0 — once past the window we still render 0 rather than
 * negative numbers (the doc is about to disappear on the next sweep).
 */
export function trashDaysRemaining(deletedAt: string | null): number | null {
  if (!deletedAt) return null;
  const deleted = new Date(deletedAt);
  if (Number.isNaN(deleted.getTime())) return null;
  const expiresAt = new Date(deleted);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + DEFAULT_TRASH_DELAY_DAYS);
  const msLeft = expiresAt.getTime() - Date.now();
  const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  return daysLeft;
}
