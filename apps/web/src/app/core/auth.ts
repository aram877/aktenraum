import { inject, Injectable } from "@angular/core";
import {
  injectMutation,
  injectQuery,
  QueryClient,
} from "@tanstack/angular-query-experimental";

import { ApiClient, statusOf, type User } from "./api";

export const ME_KEY = ["me"] as const;

@Injectable({ providedIn: "root" })
export class AuthApi {
  private readonly api = inject(ApiClient);

  me(): Promise<User> {
    return this.api.get<User>("/auth/me");
  }

  login(username: string, password: string): Promise<User> {
    return this.api.post<User>("/auth/login", { username, password });
  }

  logout(): Promise<void> {
    return this.api.post<void>("/auth/logout");
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.api.post<void>("/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
  }
}

export function injectMe() {
  const auth = inject(AuthApi);
  return injectQuery(() => ({
    queryKey: ME_KEY,
    queryFn: () => auth.me(),
    retry: (failureCount: number, error: unknown) => {
      if (statusOf(error) === 401) return false;
      return failureCount < 2;
    },
    staleTime: 60_000,
  }));
}

export function injectLogin() {
  const auth = inject(AuthApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (vars: { username: string; password: string }) =>
      auth.login(vars.username, vars.password),
    onSuccess: (user: User) => {
      queryClient.setQueryData(ME_KEY, user);
    },
  }));
}

export function injectLogout() {
  const auth = inject(AuthApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: () => auth.logout(),
    onSettled: () => {
      queryClient.setQueryData(ME_KEY, undefined);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  }));
}

export function injectChangePassword() {
  const auth = inject(AuthApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      auth.changePassword(vars.currentPassword, vars.newPassword),
    onSuccess: () => {
      queryClient.setQueryData(ME_KEY, undefined);
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  }));
}
