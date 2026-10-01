import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

export interface User {
  username: string;
}

export const ME_KEY = ["me"] as const;

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

export function useLogin() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { username: string; password: string }) =>
      api.post<User>("/auth/login", vars),
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, user);
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

export function useChangePassword() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      api.post<unknown>("/auth/change-password", {
        current_password: vars.currentPassword,
        new_password: vars.newPassword,
      }),
    onSuccess: () => {
      queryClient.setQueryData(ME_KEY, null);
    },
  });
}
