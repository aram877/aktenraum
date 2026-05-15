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
      // error surfaced below
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-hairline bg-surface p-8"
      >
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-ink">
          aktenraum
        </h1>
        <p className="mb-7 text-sm text-ink-subtle">Melde dich an, um fortzufahren.</p>

        <label className="block text-xs font-medium text-ink-muted">
          Benutzername
          <input
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>
        <label className="mt-4 block text-xs font-medium text-ink-muted">
          Passwort
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>

        {login.isError && (
          <p className="mt-3 text-sm text-red-600">
            Ungültige Anmeldedaten. Bitte erneut versuchen.
          </p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
        >
          {login.isPending ? "Anmelden…" : "Anmelden"}
        </button>
      </form>
    </main>
  );
}
