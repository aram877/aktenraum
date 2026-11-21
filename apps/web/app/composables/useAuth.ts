import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export interface User {
  username: string;
  /** From `/auth/me`; household management is shown only to `admin`. */
  household_role?: "admin" | "member";
  /** The session may only enrol a passkey (password or recovery-code sign-in). */
  enrolment_required?: boolean;
  auth_method?: "password" | "invite" | "passkey" | "recovery" | "setup";
}

export const ME_KEY = ["me"] as const;
export const WEBAUTHN_KEY = ["auth", "webauthn"] as const;

export function meQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ME_KEY,
    queryFn: async (): Promise<User | null> => {
      try {
        return await api.get<User>("/auth/me");
      } catch (error: unknown) {
        if (statusOf(error) === 401) return null;
        throw error;
      }
    },
    retry: (failureCount: number) => failureCount < 2,
    staleTime: 60_000,
  });
}

export function useMe() {
  return useQuery(meQuery(useApi()));
}

/** True for the household admin (members, models, auto-approve, backup). */
export function useIsHouseholdAdmin() {
  const me = useMe();
  return computed(() => me.data.value?.household_role === "admin");
}

/** Where passkeys work (`WEBAUTHN_ORIGINS`) — public. */
export function useWebauthnConfig() {
  const api = useApi();
  return useQuery({
    queryKey: WEBAUTHN_KEY,
    queryFn: () => api.get<{ origins: string[] }>("/auth/webauthn"),
    staleTime: Infinity,
    retry: false,
  });
}

/** Re-reads `/auth/me` after the session cookie changed. */
async function refreshMe(api: ApiClient, queryClient: ReturnType<typeof useQueryClient>): Promise<User | null> {
  return queryClient.fetchQuery({ ...meQuery(api), staleTime: 0, retry: false });
}

/** First sign-in with a password: the session may only enrol a passkey. */
export function useLogin() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { username: string; password: string }) =>
      api.post<User>("/auth/login", vars),
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, { ...user, enrolment_required: true, auth_method: "password" });
    },
  });
}

/** Discoverable passkey sign-in — no username. */
export function usePasskeyLogin() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<User | null> => {
      const begin = await api.post<CeremonyStart<PublicKeyCredentialRequestOptionsJSON>>("/auth/passkeys/login/begin");
      const response = await getPasskeyAssertion(begin.options);
      await api.post<unknown>("/auth/passkeys/login/finish", { ceremony: begin.ceremony, response });
      return refreshMe(api, queryClient);
    },
  });
}

/** Username + recovery code: a session restricted to enrolling a new passkey. */
export function useRecoveryLogin() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { username: string; code: string }) =>
      api.post<{ username: string; enrolment_required: true }>("/auth/recovery", vars),
    onSuccess: (result) => {
      queryClient.setQueryData(ME_KEY, { username: result.username, enrolment_required: true, auth_method: "recovery" });
    },
  });
}

export interface PasskeyView {
  id: number;
  name: string;
  provider: string;
  synced: boolean;
  rp_id: string;
  created_at: string;
  last_used_at: string | null;
  prf: boolean;
}

export const PASSKEYS_KEY = ["auth", "passkeys"] as const;
export const RECOVERY_KEY = ["auth", "recovery-codes"] as const;

/**
 * Creates a passkey for the signed-in member: the first one of a restricted
 * session (enrolment — answers recovery codes and a new session cookie) or
 * another one (needs a step-up, handled by `useApi`).
 */
export function useRegisterPasskey() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { name?: string } = {}) => {
      const begin = await api.post<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>("/auth/passkeys/register/begin", {});
      const response = await createPasskey(begin.options);
      return api.post<{ passkey: PasskeyView; recovery_codes: string[] | null }>("/auth/passkeys/register/finish", {
        ceremony: begin.ceremony,
        response,
        ...(vars.name ? { name: vars.name } : {}),
      });
    },
    onSuccess: async () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      void queryClient.invalidateQueries({ queryKey: RECOVERY_KEY });
      await refreshMe(api, queryClient);
    },
  });
}

export function useLogout() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>("/auth/logout"),
    onSettled: () => {
      queryClient.setQueryData(ME_KEY, null);
    },
  });
}
