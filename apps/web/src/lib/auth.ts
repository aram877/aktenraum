import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { changePassword, fetchMe, login, logout, type User } from "./api";

const ME_KEY = ["me"] as const;

// Auth state is derived from `/api/auth/me`. 200 → authenticated, 401 →
// unauthenticated. The component layer never inspects cookies directly.
export function useMe() {
  return useQuery<User, AxiosError>({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    retry: (failureCount, error) => {
      if (error.response?.status === 401) return false;
      return failureCount < 2;
    },
    staleTime: 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      login(username, password),
    onSuccess: (user) => {
      qc.setQueryData(ME_KEY, user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSettled: () => {
      qc.setQueryData(ME_KEY, undefined);
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

// The server clears the auth cookie on success, so we also drop the cached
// `/me` state. Caller is responsible for navigating to /login.
export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation<void, AxiosError, { currentPassword: string; newPassword: string }>({
    mutationFn: ({ currentPassword, newPassword }) =>
      changePassword(currentPassword, newPassword),
    onSuccess: () => {
      qc.setQueryData(ME_KEY, undefined);
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}
