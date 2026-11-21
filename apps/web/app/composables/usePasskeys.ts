import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

/** The member's own passkeys (`/settings → Konto`). */
export function usePasskeyList() {
  const api = useApi();
  return useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: () => api.get<PasskeyView[]>("/auth/passkeys"),
    staleTime: 30_000,
  });
}

export function useRenamePasskey() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; name: string }) => api.patch<PasskeyView>(`/auth/passkeys/${vars.id}`, { name: vars.name }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY }),
  });
}

export function useRemovePasskey() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<unknown>(`/auth/passkeys/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY }),
  });
}

export function useRecoveryStatus() {
  const api = useApi();
  return useQuery({
    queryKey: RECOVERY_KEY,
    queryFn: () => api.get<{ remaining: number }>("/auth/recovery-codes"),
    staleTime: 30_000,
  });
}

/** A new set; the old unused codes stop working. Answers the codes once. */
export function useRegenerateRecoveryCodes() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ codes: string[] }>("/auth/recovery-codes"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: RECOVERY_KEY }),
  });
}

// ---------------------------------------------------------------------------
// Setup links
// ---------------------------------------------------------------------------

export interface CreatedSetupLink {
  id: number;
  /** Shown exactly once. */
  token: string;
  expires_at: string;
}

/** The link to hand over; built here because only the browser knows the public origin. */
export function setupUrl(token: string, origin: string = window.location.origin): string {
  return `${origin}/setup/${encodeURIComponent(token)}`;
}

/** Household admin: a single-use setup link for a member (step-up via `useApi`). */
export function useCreateSetupLink() {
  const api = useApi();
  return useMutation({
    mutationFn: (memberId: number) => api.post<CreatedSetupLink>(`/household/members/${memberId}/setup-link`),
  });
}

/** Public: whom a setup link is for (404 = invalid, expired, used or revoked). */
export function useSetupCheck(token: MaybeRefOrGetter<string>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: ["setup", toValue(token)],
    queryFn: () => api.get<{ username: string; expires_at: string }>(`/setup/${encodeURIComponent(toValue(token))}`),
    retry: false,
    staleTime: 30_000,
  }));
}

/** Public: enrol a passkey with a setup link — signs in and answers new recovery codes. */
export function useSetupEnrol(token: MaybeRefOrGetter<string>) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const path = `/setup/${encodeURIComponent(toValue(token))}/register`;
      const begin = await api.post<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>(`${path}/begin`);
      const response = await createPasskey(begin.options);
      return api.post<{ username: string; recovery_codes: string[] | null }>(`${path}/finish`, {
        ceremony: begin.ceremony,
        response,
      });
    },
    onSuccess: async () => {
      await queryClient.fetchQuery({ ...meQuery(api), staleTime: 0, retry: false });
    },
  });
}
