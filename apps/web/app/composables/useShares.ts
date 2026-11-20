import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

export type ShareRole = "viewer" | "editor";

export interface ShareEntry {
  member_id: number;
  username: string;
  role: ShareRole;
  expires_at: string | null;
  granted_at: string;
  granted_by: string | null;
}

export type ShareAuditEvent = "granted" | "role_changed" | "expiry_changed" | "revoked" | "expired" | "accessed";

export interface ShareAuditEntry {
  id: number;
  member_id: number;
  member: string | null;
  actor: string | null;
  event: ShareAuditEvent;
  access_kind: "detail" | "preview" | "download" | "ask" | null;
  at: string;
}

export interface SharedWithMeEntry {
  doc_id: number;
  title: string;
  shared_by: string | null;
  role: ShareRole;
  expires_at: string | null;
}

export interface SharedByMeEntry {
  doc_id: number;
  title: string;
  member: { id: number; username: string };
  role: ShareRole;
  expires_at: string | null;
  granted_at: string;
}

export const SHARES_KEY = ["shares"] as const;

/** Active shares of one document (home-space owner only). */
export function useShares(docId: MaybeRefOrGetter<number | null>, enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...SHARES_KEY, toValue(docId)],
    queryFn: () => api.get<ShareEntry[]>(`/documents/${toValue(docId)}/shares`),
    enabled: toValue(docId) !== null && toValue(enabled),
    staleTime: 30_000,
  }));
}

export function useShareAudit(docId: MaybeRefOrGetter<number | null>, enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...SHARES_KEY, toValue(docId), "audit"],
    queryFn: () => api.get<ShareAuditEntry[]>(`/documents/${toValue(docId)}/shares/audit`),
    enabled: toValue(docId) !== null && toValue(enabled),
    staleTime: 30_000,
  }));
}

export function useSharedWithMe(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...SHARES_KEY, "with-me"],
    queryFn: () => api.get<SharedWithMeEntry[]>("/shares/with-me"),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

export function useSharedByMe(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: [...SHARES_KEY, "by-me"],
    queryFn: () => api.get<SharedByMeEntry[]>("/shares/by-me"),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

/** A share changed: every share list, and the document's detail. */
function invalidateShares(queryClient: QueryClient, docId: number): void {
  void queryClient.invalidateQueries({ queryKey: SHARES_KEY });
  void queryClient.invalidateQueries({ queryKey: [DOCUMENT_DETAIL_KEY, docId] });
}

export function useGrantShare() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { docId: number; memberId: number; role: ShareRole; expiresAt: string | null }) =>
      api.post<ShareEntry>(`/documents/${vars.docId}/shares`, {
        member_id: vars.memberId,
        role: vars.role,
        ...(vars.expiresAt !== null ? { expires_at: vars.expiresAt } : {}),
      }),
    onSuccess: (_data, vars) => invalidateShares(queryClient, vars.docId),
  });
}

export function useChangeShare() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { docId: number; memberId: number; role?: ShareRole; expiresAt?: string | null }) =>
      api.patch<ShareEntry>(`/documents/${vars.docId}/shares/${vars.memberId}`, {
        ...(vars.role !== undefined ? { role: vars.role } : {}),
        ...(vars.expiresAt !== undefined ? { expires_at: vars.expiresAt } : {}),
      }),
    onSuccess: (_data, vars) => invalidateShares(queryClient, vars.docId),
  });
}

export function useRevokeShare() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { docId: number; memberId: number }) =>
      api.del<unknown>(`/documents/${vars.docId}/shares/${vars.memberId}`),
    onSuccess: (_data, vars) => invalidateShares(queryClient, vars.docId),
  });
}

/**
 * The chosen expiry day as an absolute instant: the end of that day in the
 * browser's time zone (design §10). `""` = no expiry.
 */
export function endOfLocalDay(day: string): string | null {
  if (day === "") return null;
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 0).toISOString();
}

/** A stored expiry back to the `<input type="date">` value (local day). */
export function localDayOf(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const EVENT_LABELS: Record<ShareAuditEvent, string> = {
  granted: "Geteilt",
  role_changed: "Rolle geändert",
  expiry_changed: "Ablauf geändert",
  revoked: "Freigabe entzogen",
  expired: "Abgelaufen",
  accessed: "Zugriff",
};

const ACCESS_LABELS: Record<NonNullable<ShareAuditEntry["access_kind"]>, string> = {
  detail: "Geöffnet",
  preview: "Vorschau",
  download: "Download",
  ask: "In Ask AI zitiert",
};

/** "bob – Download" / "Geteilt mit bob (durch alice)" */
export function auditLabel(entry: ShareAuditEntry): string {
  const member = entry.member ?? `#${entry.member_id}`;
  if (entry.event === "accessed") {
    return `${member} – ${entry.access_kind ? ACCESS_LABELS[entry.access_kind] : EVENT_LABELS.accessed}`;
  }
  const by = entry.actor && entry.actor !== member ? ` (durch ${entry.actor})` : "";
  return `${EVENT_LABELS[entry.event]}: ${member}${by}`;
}

export const SHARE_ROLE_LABELS: Record<ShareRole, string> = {
  viewer: "Ansehen",
  editor: "Bearbeiten",
};
