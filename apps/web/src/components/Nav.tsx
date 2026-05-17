import { Link, useNavigate } from "@tanstack/react-router";

import { useInFlightCount } from "../lib/documents";
import { useInboxList } from "../lib/inbox";
import { useLogout, useMe } from "../lib/auth";
import { useTrashCount } from "../lib/trash";

export function Nav({
  active,
}: {
  active:
    | "home"
    | "ask"
    | "find"
    | "library"
    | "upload"
    | "inbox"
    | "trash"
    | "settings";
}) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const inbox = useInboxList({ pageSize: 1 });
  const inFlight = useInFlightCount();
  const trashCount = useTrashCount();

  const onLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  const linkCls = (key: typeof active) =>
    `text-sm transition-colors ${
      active === key
        ? "font-medium text-ink"
        : "text-ink-muted hover:text-ink"
    }`;

  const inboxCount = inbox.data?.total ?? null;
  const processingCount = Math.max(
    0,
    (inFlight.data?.count ?? 0) - (inboxCount ?? 0),
  );

  return (
    <header className="flex items-center justify-between border-b border-hairline bg-canvas px-6 py-3">
      <div className="flex items-center gap-7">
        <Link
          to="/"
          className="text-sm font-semibold tracking-tight text-ink"
        >
          aktenraum
        </Link>
        <nav className="flex items-center gap-5">
          <Link to="/" className={linkCls("home")}>
            Start
          </Link>
          <Link to="/ask" className={linkCls("ask")}>
            Ask AI
          </Link>
          <Link to="/find" className={linkCls("find")}>
            Dokumente finden
          </Link>
          <Link
            to="/library"
            search={{ tab: "archive" }}
            className={`${linkCls("library")} flex items-center gap-1.5`}
          >
            <span>Bibliothek</span>
            {inboxCount !== null && inboxCount > 0 && (
              <span
                title="Dokumente zur Prüfung"
                className="inline-flex min-w-[1.25rem] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
              >
                {inboxCount}
              </span>
            )}
          </Link>
          <Link to="/upload" className={linkCls("upload")}>
            + Hochladen
          </Link>
          <Link
            to="/trash"
            className={`${linkCls("trash")} flex items-center gap-1.5`}
          >
            <span>Papierkorb</span>
            {(trashCount.data?.total ?? 0) > 0 && (
              <span
                title="Im Papierkorb"
                className="inline-flex min-w-[1.25rem] justify-center rounded-full bg-zinc-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
              >
                {trashCount.data?.total}
              </span>
            )}
          </Link>
          <Link to="/settings" className={linkCls("settings")}>
            Einstellungen
          </Link>
        </nav>
      </div>
      <div className="flex items-center gap-3 text-sm text-ink-muted">
        {processingCount > 0 && (
          <span
            title="Dokumente werden gerade von der KI verarbeitet"
            className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs text-accent"
          >
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
              aria-hidden
            />
            {processingCount} in Bearbeitung
          </span>
        )}
        <span className="text-ink-subtle">{me.data?.username ?? "…"}</span>
        <button
          onClick={onLogout}
          disabled={logout.isPending}
          className="rounded-md border border-hairline bg-surface px-3 py-1 text-xs text-ink-muted hover:bg-canvas hover:text-ink disabled:opacity-60"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
