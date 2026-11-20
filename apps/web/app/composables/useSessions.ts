import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

/** One of the member's own active sessions (`GET /api/auth/sessions`). */
export interface SessionEntry {
  id: number;
  created_at: string;
  last_seen_at: string;
  auth_method: "password" | "invite" | "passkey" | "recovery" | "setup";
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export const SESSIONS_KEY = ["auth", "sessions"] as const;

export function useSessions() {
  const api = useApi();
  return useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api.get<SessionEntry[]>("/auth/sessions"),
    staleTime: 30_000,
  });
}

/** Signs out one device; signing out this one is a logout. */
export function useRevokeSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (session: Pick<SessionEntry, "id" | "current">) => api.del<unknown>(`/auth/sessions/${session.id}`),
    onSuccess: (_result, session) => {
      if (session.current) {
        queryClient.setQueryData(ME_KEY, null);
        queryClient.removeQueries({ queryKey: SESSIONS_KEY });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
}

export function useRevokeOtherSessions() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ revoked: number }>("/auth/sessions/revoke-others"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
}
