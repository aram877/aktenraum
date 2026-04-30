import { useNavigate } from "@tanstack/react-router";

import { useLogout, useMe } from "../lib/auth";

export function Home() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
        <span className="text-sm font-semibold tracking-tight">aktenraum</span>
        <div className="flex items-center gap-3 text-sm text-neutral-700">
          <span>{me.data?.username ?? "…"}</span>
          <button
            onClick={onLogout}
            disabled={logout.isPending}
            className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-60"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 px-6 py-12 text-neutral-600">
        <p className="text-sm">
          Phase 1 shell — the AI features land in subsequent phases.
        </p>
      </main>
    </div>
  );
}
