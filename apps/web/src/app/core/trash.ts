import { inject, Injectable } from "@angular/core";
import {
  injectMutation,
  injectQuery,
  QueryClient,
} from "@tanstack/angular-query-experimental";

import { ApiClient } from "./api";

export interface TrashItem {
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
}

export interface TrashList {
  results: TrashItem[];
  total: number;
  page: number;
  page_size: number;
}

export const TRASH_KEY = ["trash"] as const;

const DEFAULT_PURGE_DAYS = 30;

export function daysLeft(deletedAt: string | null, now: Date = new Date()): number | null {
  if (!deletedAt) return null;
  const deleted = new Date(deletedAt);
  if (Number.isNaN(deleted.getTime())) return null;
  const elapsedDays = (now.getTime() - deleted.getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(DEFAULT_PURGE_DAYS - elapsedDays));
}

@Injectable({ providedIn: "root" })
export class TrashApi {
  private readonly api = inject(ApiClient);

  list(page = 1, pageSize = 20): Promise<TrashList> {
    return this.api.get<TrashList>(`/trash/?page=${page}&page_size=${pageSize}`);
  }

  restore(id: number): Promise<void> {
    return this.api.post<void>(`/trash/${id}/restore`, {});
  }

  deleteForever(id: number): Promise<void> {
    return this.api.post<void>(`/trash/${id}/delete`, {});
  }

  empty(): Promise<{ emptied: number }> {
    return this.api.post<{ emptied: number }>("/trash/empty", {});
  }
}

export function injectTrashList() {
  const api = inject(TrashApi);
  return injectQuery(() => ({
    queryKey: [...TRASH_KEY, "list"],
    queryFn: () => api.list(),
    staleTime: 15_000,
  }));
}

function invalidateAll(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: TRASH_KEY });
  void queryClient.invalidateQueries({ queryKey: ["library"] });
}

export function injectRestore() {
  const api = inject(TrashApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (id: number) => api.restore(id),
    onSuccess: () => invalidateAll(queryClient),
  }));
}

export function injectDeleteForever() {
  const api = inject(TrashApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (id: number) => api.deleteForever(id),
    onSuccess: () => invalidateAll(queryClient),
  }));
}

export function injectEmptyTrash() {
  const api = inject(TrashApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: () => api.empty(),
    onSuccess: () => invalidateAll(queryClient),
  }));
}
