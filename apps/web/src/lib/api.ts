import axios from "axios";

// Single axios instance shared by every feature. `withCredentials: true` is the
// load-bearing flag — it tells the browser to include the auth cookie on /api
// calls, which is how every endpoint after /api/auth/login knows who you are.
export const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

export type User = { username: string };

export async function login(username: string, password: string): Promise<User> {
  const { data } = await api.post<User>("/auth/login", { username, password });
  return data;
}

export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

export async function fetchMe(): Promise<User> {
  const { data } = await api.get<User>("/auth/me");
  return data;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await api.post("/auth/change-password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}
