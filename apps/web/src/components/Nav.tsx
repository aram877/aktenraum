import { Link, useNavigate } from "@tanstack/react-router";

import { useInFlightCount } from "../lib/documents";
import { useInboxList } from "../lib/inbox";
import { useLogout, useMe } from "../lib/auth";

export function Nav({
  active,
}: {
  active: "home" | "ask" | "find" | "library" | "upload" | "inbox";
}) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const inbox = useInboxList({ pageSize: 1 });
  const inFlight = useInFlightCount();

  const onLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  const linkCls = (key: typeof active) =>
    `text-sm ${
      active === key
        ? "font-medium text-neutral-900"
        : "text-neutral-600 hover:text-neutral-900"
    }`;

  const inboxCount = inbox.data?.total ?? null;
  // Subtract pending docs from in-flight so the global pill represents docs
  // *being processed by the auto-tagger right now* (= ai-approved waiting on
  // propagation, primarily). Pending docs already get their own Inbox badge.
  const processingCount = Math.max(
    0,
    (inFlight.data?.count ?? 0) - (inboxCount ?? 0),
  );

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
      <div className="flex items-center gap-6">
        <Link to="/" className="text-sm font-semibold tracking-tight">
          aktenraum
        </Link>
        <nav className="flex items-center gap-4">
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
        </nav>
      </div>
      <div className="flex items-center gap-3 text-sm text-neutral-700">
        {processingCount > 0 && (
          <span
            title="Dokumente werden gerade von der KI verarbeitet"
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-800"
          >
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-600"
              aria-hidden
            />
            {processingCount} in Bearbeitung
          </span>
        )}
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
  );
}
