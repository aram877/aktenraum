import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useLogin } from "../lib/auth";

export function Login() {
  const navigate = useNavigate();
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login.mutateAsync({ username, password });
      await navigate({ to: "/" });
    } catch {
      // Mutation state surfaces the error message below; nothing else to do.
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-6 text-xl font-semibold tracking-tight">aktenraum</h1>
        <label className="block text-sm font-medium text-neutral-700">
          Username
          <input
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-0"
          />
        </label>
        <label className="mt-4 block text-sm font-medium text-neutral-700">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-0"
          />
        </label>
        {login.isError && (
          <p className="mt-3 text-sm text-red-600">
            Invalid credentials. Try again.
          </p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 block w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
