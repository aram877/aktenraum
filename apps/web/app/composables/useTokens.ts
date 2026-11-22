import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

/** What a personal access token may carry (mirrors the api's TOKEN_SCOPES). */
export const TOKEN_SCOPES = [
  "documents:read",
  "documents:write",
  "documents:delete",
  "upload",
  "ai:ask",
  "settings:read",
  "shares:manage",
  "spaces:manage",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const TOKEN_SCOPE_LABELS: Record<TokenScope, string> = {
  "documents:read": "Dokumente lesen",
  "documents:write": "Dokumente bearbeiten",
  "documents:delete": "Dokumente löschen",
  upload: "Hochladen",
  "ai:ask": "KI-Fragen",
  "settings:read": "Einstellungen lesen",
  "shares:manage": "Freigaben verwalten",
  "spaces:manage": "Akten verwalten",
};

export const TOKEN_MAX_DAYS = 365;

/** One of the member's tokens (`GET /api/auth/tokens`). Never carries the value. */
export interface TokenEntry {
  id: number;
  name: string;
  scopes: TokenScope[];
  display_prefix: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  state: "active" | "expired" | "revoked";
}

export interface CreateTokenInput {
  name: string;
  scopes: TokenScope[];
  expires_in_days: number;
}

export interface CreatedToken {
  token: TokenEntry;
  /** Shown once; the server never returns it again. */
  value: string;
}

export const TOKENS_KEY = ["auth", "tokens"] as const;

export function useTokens() {
  const api = useApi();
  return useQuery({
    queryKey: TOKENS_KEY,
    queryFn: () => api.get<TokenEntry[]>("/auth/tokens"),
    staleTime: 30_000,
  });
}

/** Creating needs a passkey confirmation; `useApi` runs it and repeats the request. */
export function useCreateToken() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTokenInput) => api.post<CreatedToken>("/auth/tokens", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });
}

export function useRevokeToken() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<unknown>(`/auth/tokens/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });
}
