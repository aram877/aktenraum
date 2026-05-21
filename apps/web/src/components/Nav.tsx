import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useInFlightCount } from "../lib/documents";
import { useInboxList } from "../lib/inbox";
import { useLogout, useMe } from "../lib/auth";
import { useTrashCount } from "../lib/trash";
import { MenuIcon, XIcon } from "./Icons";

type NavKey =
  | "home"
  | "ask"
  | "find"
  | "library"
  | "upload"
  | "inbox"
  | "trash"
  | "settings";

export function Nav({ active }: { active: NavKey }) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const inbox = useInboxList({ pageSize: 1 });
  const inFlight = useInFlightCount();
  const trashCount = useTrashCount();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  const onLogout = async () => {
    setMenuOpen(false);
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  const inboxCount = inbox.data?.total ?? null;
  const processingCount = Math.max(
    0,
    (inFlight.data?.count ?? 0) - (inboxCount ?? 0),
  );
  const trashTotal = trashCount.data?.total ?? 0;

  const linkCls = (key: NavKey) =>
    `text-sm transition-colors ${
      active === key
        ? "font-medium text-ink"
        : "text-ink-muted hover:text-ink"
    }`;

  const drawerLinkCls = (key: NavKey) =>
    `flex items-center justify-between rounded-md px-3 py-3 text-base transition-colors ${
      active === key
        ? "bg-surface-raised font-medium text-ink"
        : "text-ink-muted hover:bg-surface-raised hover:text-ink"
    }`;

  const badgeAmber =
    "inline-flex min-w-[1.25rem] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white";
  const badgeZinc =
    "inline-flex min-w-[1.25rem] justify-center rounded-full bg-zinc-500 px-1.5 py-0.5 text-[10px] font-semibold text-white";

  return (
    <header className="relative border-b border-hairline bg-canvas">
      <div className="flex items-center justify-between px-4 py-3 md:px-6">
        {/* Brand + desktop nav */}
        <div className="flex min-w-0 items-center gap-7">
          <Link
            to="/"
            className="text-sm font-semibold tracking-tight text-ink"
            onClick={() => setMenuOpen(false)}
          >
            aktenraum
          </Link>
          <nav className="hidden items-center gap-5 md:flex">
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
                <span title="Dokumente zur Prüfung" className={badgeAmber}>
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
              {trashTotal > 0 && (
                <span title="Im Papierkorb" className={badgeZinc}>
                  {trashTotal}
                </span>
              )}
            </Link>
            <Link to="/settings" className={linkCls("settings")}>
              Einstellungen
            </Link>
          </nav>
        </div>

        {/* Desktop right side */}
        <div className="hidden items-center gap-3 text-sm text-ink-muted md:flex">
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

        {/* Mobile: hamburger + compact status */}
        <div className="flex items-center gap-2 md:hidden">
          {processingCount > 0 && (
            <span
              title="In Bearbeitung"
              className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
            >
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                aria-hidden
              />
              {processingCount}
            </span>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Menü schließen" : "Menü öffnen"}
            aria-expanded={menuOpen}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-hairline bg-surface text-ink-muted hover:bg-canvas hover:text-ink"
          >
            {menuOpen ? (
              <XIcon className="h-4 w-4" />
            ) : (
              <MenuIcon className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 top-[57px] z-40 bg-black/30 md:hidden"
            aria-hidden
            onClick={() => setMenuOpen(false)}
          />
          <nav
            className="fixed inset-x-0 top-[57px] z-50 max-h-[calc(100vh-57px)] overflow-y-auto border-b border-hairline bg-canvas px-4 py-3 shadow-lg md:hidden"
            role="dialog"
            aria-label="Hauptnavigation"
          >
            <Link to="/" className={drawerLinkCls("home")} onClick={() => setMenuOpen(false)}>
              <span>Start</span>
            </Link>
            <Link to="/ask" className={drawerLinkCls("ask")} onClick={() => setMenuOpen(false)}>
              <span>Ask AI</span>
            </Link>
            <Link to="/find" className={drawerLinkCls("find")} onClick={() => setMenuOpen(false)}>
              <span>Dokumente finden</span>
            </Link>
            <Link
              to="/library"
              search={{ tab: "archive" }}
              className={drawerLinkCls("library")}
              onClick={() => setMenuOpen(false)}
            >
              <span>Bibliothek</span>
              {inboxCount !== null && inboxCount > 0 && (
                <span className={badgeAmber}>{inboxCount}</span>
              )}
            </Link>
            <Link to="/upload" className={drawerLinkCls("upload")} onClick={() => setMenuOpen(false)}>
              <span>+ Hochladen</span>
            </Link>
            <Link to="/trash" className={drawerLinkCls("trash")} onClick={() => setMenuOpen(false)}>
              <span>Papierkorb</span>
              {trashTotal > 0 && <span className={badgeZinc}>{trashTotal}</span>}
            </Link>
            <Link to="/settings" className={drawerLinkCls("settings")} onClick={() => setMenuOpen(false)}>
              <span>Einstellungen</span>
            </Link>

            <div className="mt-3 flex items-center justify-between border-t border-hairline pt-3 text-sm">
              <span className="text-ink-subtle">
                Angemeldet als{" "}
                <span className="font-medium text-ink-muted">
                  {me.data?.username ?? "…"}
                </span>
              </span>
              <button
                onClick={onLogout}
                disabled={logout.isPending}
                className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-ink-muted hover:bg-canvas hover:text-ink disabled:opacity-60"
              >
                Sign out
              </button>
            </div>
          </nav>
        </>
      )}
    </header>
  );
}
