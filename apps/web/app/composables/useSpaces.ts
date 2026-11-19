import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export type SpaceRole = "owner" | "editor" | "viewer";
export type MemberRole = Exclude<SpaceRole, "owner">;

export interface SpaceSummary {
  id: number;
  name: string;
  kind: "personal" | "shared";
  /** The current member's role in it. */
  role: SpaceRole;
  owner: string | null;
  member_count: number;
  document_count: number;
}

export interface SpaceList {
  household_member_count: number;
  spaces: SpaceSummary[];
}

export interface SpaceMember {
  member_id: number;
  username: string;
  role: SpaceRole;
}

export interface DirectoryEntry {
  id: number;
  username: string;
}

export type MoveStatus = "moved" | "unchanged" | "forbidden" | "not_found" | "failed";

export interface MoveResult {
  doc_id: number;
  status: MoveStatus;
  detail?: string;
}

export const SPACES_KEY = ["spaces"] as const;
export const DIRECTORY_KEY = ["household", "directory"] as const;

/** Spaces ("Akten") of the current member, plus the household size that gates the UI. */
export function useSpaces(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: SPACES_KEY,
    queryFn: () => api.get<SpaceList>("/spaces"),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

/**
 * Space UI only exists once the household has a second member (ADR-009). False
 * while loading, so a household of one never sees it flash.
 */
export function useSpacesVisible(enabled: MaybeRefOrGetter<boolean> = true) {
  const spaces = useSpaces(enabled);
  const visible = computed(() => (spaces.data.value?.household_member_count ?? 0) >= 2);
  return { spaces, visible };
}

/** Spaces the member may put documents into: owner or editor. Personal first. */
export function placeableSpaces(list: SpaceList | undefined | null): SpaceSummary[] {
  return (list?.spaces ?? [])
    .filter((s) => s.role === "owner" || s.role === "editor")
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "de") : a.kind === "personal" ? -1 : 1));
}

/** "Persönlich" alone is ambiguous next to shared spaces; name it as the member's own. */
export function spaceLabel(space: { name: string; kind: "personal" | "shared" }): string {
  return space.kind === "personal" ? "Meine persönliche Akte" : space.name;
}

export function useSpaceMembers(spaceId: MaybeRefOrGetter<number | null>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...SPACES_KEY, toValue(spaceId), "members"],
    queryFn: () => api.get<SpaceMember[]>(`/spaces/${toValue(spaceId)}/members`),
    enabled: toValue(spaceId) !== null,
    staleTime: 30_000,
  }));
}

export function useHouseholdDirectory(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: DIRECTORY_KEY,
    queryFn: () => api.get<DirectoryEntry[]>("/household/directory"),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

function invalidateSpaces(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: SPACES_KEY });
}

/** A document changed space (or vanished from view): every list that shows it. */
function invalidateDocuments(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: SPACES_KEY });
  void queryClient.invalidateQueries({ queryKey: ["library"] });
  void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  void queryClient.invalidateQueries({ queryKey: [DOCUMENT_DETAIL_KEY] });
}

export function useCreateSpace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<SpaceSummary>("/spaces", { name }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function useRenameSpace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; name: string }) => api.patch<unknown>(`/spaces/${vars.id}`, { name: vars.name }),
    // Library rows and detail badges show the name.
    onSuccess: () => invalidateDocuments(queryClient),
  });
}

export function useDeleteSpace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<unknown>(`/spaces/${id}`),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function useAddSpaceMember() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { spaceId: number; memberId: number; role: MemberRole }) =>
      api.post<SpaceMember>(`/spaces/${vars.spaceId}/members`, { member_id: vars.memberId, role: vars.role }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

export function useChangeSpaceRole() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { spaceId: number; memberId: number; role: MemberRole }) =>
      api.patch<SpaceMember>(`/spaces/${vars.spaceId}/members/${vars.memberId}`, { role: vars.role }),
    onSuccess: () => invalidateSpaces(queryClient),
  });
}

/** The owner removes a member, or the caller leaves (memberId = their own). */
export function useRemoveSpaceMember() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { spaceId: number; memberId: number }) =>
      api.del<unknown>(`/spaces/${vars.spaceId}/members/${vars.memberId}`),
    // Leaving hides the space's documents at once.
    onSuccess: () => invalidateDocuments(queryClient),
  });
}

export function useMoveDocument() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { docId: number; spaceId: number }) =>
      api.post<MoveResult>(`/documents/${vars.docId}/move`, { space_id: vars.spaceId }),
    onSuccess: () => invalidateDocuments(queryClient),
  });
}

export function useBulkMove() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { spaceId: number; docIds: number[] }) =>
      api.post<{ results: MoveResult[] }>(`/spaces/${vars.spaceId}/documents`, { doc_ids: vars.docIds }),
    // Partial results still moved some documents.
    onSettled: () => invalidateDocuments(queryClient),
  });
}

/** "3 verschoben · 1 nicht erlaubt" for the bulk result line. */
export function summarizeMoves(results: readonly MoveResult[]): string {
  const counts = new Map<MoveStatus, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const labels: [MoveStatus, string][] = [
    ["moved", "verschoben"],
    ["unchanged", "schon dort"],
    ["forbidden", "nicht erlaubt"],
    ["not_found", "nicht gefunden"],
    ["failed", "fehlgeschlagen"],
  ];
  return labels
    .filter(([status]) => counts.has(status))
    .map(([status, label]) => `${counts.get(status)} ${label}`)
    .join(" · ");
}
