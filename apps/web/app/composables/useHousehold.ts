import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

export interface HouseholdMember {
  id: number;
  username: string;
  role: "admin" | "member";
  joined_at: string;
}

export interface PendingInvite {
  id: number;
  created_at: string;
  expires_at: string;
}

export interface CreatedInvite extends PendingInvite {
  /** Shown exactly once — the api stores only its hash. */
  token: string;
}

export const HOUSEHOLD_KEY = ["household"] as const;
export const MEMBERS_KEY = [...HOUSEHOLD_KEY, "members"] as const;
export const INVITES_KEY = [...HOUSEHOLD_KEY, "invites"] as const;

/** The link an invitee opens; built here because only the browser knows the public origin. */
export function inviteUrl(token: string, origin: string = window.location.origin): string {
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

export function useHouseholdMembers(enabled: MaybeRefOrGetter<boolean>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: MEMBERS_KEY,
    queryFn: () => api.get<HouseholdMember[]>("/household/members"),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

export function usePendingInvites(enabled: MaybeRefOrGetter<boolean>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: INVITES_KEY,
    queryFn: () => api.get<PendingInvite[]>("/household/invites"),
    enabled: toValue(enabled),
    staleTime: 30_000,
  }));
}

export function useCreateInvite() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CreatedInvite>("/household/invites"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}

export function useRevokeInvite() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<unknown>(`/household/invites/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}

/** Public: is this link still redeemable? (404 = invalid, expired, used or revoked.) */
export function useInviteCheck(token: MaybeRefOrGetter<string>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: ["invite", toValue(token)],
    queryFn: () => api.get<{ expires_at: string }>(`/invites/${encodeURIComponent(toValue(token))}`),
    retry: false,
    staleTime: 30_000,
  }));
}

/** Joins with a username and a new passkey; answers the recovery codes once. */
export function useRedeemInvite(token: MaybeRefOrGetter<string>) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { username: string }) => {
      const path = `/invites/${encodeURIComponent(toValue(token))}/register`;
      const begin = await api.post<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>(`${path}/begin`, vars);
      const response = await createPasskey(begin.options);
      return api.post<{ username: string; recovery_codes: string[] | null }>(`${path}/finish`, {
        ceremony: begin.ceremony,
        response,
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(ME_KEY, {
        username: result.username,
        household_role: "member",
        enrolment_required: false,
        auth_method: "invite",
      });
    },
  });
}

// ---------------------------------------------------------------- member removal

export interface RemovalPreview {
  member_id: number;
  username: string;
  successor_member_id: number;
  successor: string;
  documents: number;
  trashed: number | null;
  spaces_owned: { id: number; name: string }[];
  spaces_left: { id: number; name: string }[];
  shares_revoked: number;
  shares_kept: number;
}

export interface RemovalEntry {
  member_id: number;
  username: string;
  successor: string;
  removed_at: string;
  status: "done" | "completing";
  last_error: string | null;
}

export interface RemovalResult {
  member_id: number;
  successor_member_id: number;
  status: "done" | "completing";
}

export const REMOVALS_KEY = [...HOUSEHOLD_KEY, "removals"] as const;
export const REMOVAL_PREVIEW_KEY = [...HOUSEHOLD_KEY, "removal-preview"] as const;
/** Poll while a removal is still catching up with Paperless/Qdrant. */
export const REMOVALS_POLL_MS = 10_000;

/** What removing `memberId` with `successorId` would do; disabled while `memberId` is null. */
export function useRemovalPreview(
  memberId: MaybeRefOrGetter<number | null>,
  successorId: MaybeRefOrGetter<number | null>,
) {
  const api = useApi();
  return useQuery(() => {
    const member = toValue(memberId);
    const successor = toValue(successorId);
    return {
      queryKey: [...REMOVAL_PREVIEW_KEY, member, successor],
      queryFn: () =>
        api.get<RemovalPreview>(
          `/household/members/${member}/removal-preview${successor === null ? "" : `?successor=${successor}`}`,
        ),
      enabled: member !== null,
      retry: false,
      staleTime: 0,
    };
  });
}

export function useRemovals(enabled: MaybeRefOrGetter<boolean>) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: REMOVALS_KEY,
    queryFn: () => api.get<RemovalEntry[]>("/household/removals"),
    enabled: toValue(enabled),
    staleTime: 30_000,
    refetchInterval: (query: { state: { data?: RemovalEntry[] } }) =>
      (query.state.data ?? []).some((r) => r.status !== "done") ? REMOVALS_POLL_MS : false,
  }));
}

export function useRemoveMember() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { memberId: number; confirmUsername: string; successorId: number | null }) =>
      api.post<RemovalResult>(`/household/members/${vars.memberId}/remove`, {
        confirm_username: vars.confirmUsername,
        ...(vars.successorId === null ? {} : { successor_member_id: vars.successorId }),
      }),
    onSuccess: () => {
      // household covers members, directory, removals and previews.
      void queryClient.invalidateQueries({ queryKey: HOUSEHOLD_KEY });
      void queryClient.invalidateQueries({ queryKey: SPACES_KEY });
      void queryClient.invalidateQueries({ queryKey: SHARES_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}
