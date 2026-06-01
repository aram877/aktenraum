import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useInFlightCount } from "../lib/documents";
import { useInboxList } from "../lib/inbox";
import { useLiveCounts, useLiveCountsSubscription } from "../lib/live";
import { useLogout, useMe } from "../lib/auth";
import { useTrashCount } from "../lib/trash";
import { isUploadInFlight, useUploads } from "../lib/upload-store";
import {
  CameraIcon,
  HomeIcon,
  LibraryIcon,
  MenuIcon,
  SettingsIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "./Icons";

type NavKey =
  | "home"
  | "ask"
  | "library"
  | "upload"
  | "scan"
  | "inbox"
  | "trash"
  | "settings";

export function Nav({ active }: { active: NavKey }) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  // Live counts ride on SSE — one subscription per session, push-based
  // so the badges update within seconds of state changing on the
  // backend (no manual refresh, no per-badge polling fan-out).
  useLiveCountsSubscription();
  const live = useLiveCounts();
  // Polled hooks stay as a fallback for the brief moment between mount
  // and the first SSE event arriving (~3s) AND for cases where SSE is
  // blocked (some corporate proxies). Their `refetchOnWindowFocus`
  // also keeps them honest if the EventSource somehow misses an event.
  const inbox = useInboxList({ pageSize: 1 });
  const inFlight = useInFlightCount();
  const trashCount = useTrashCount();
  // Read the global upload store so the Nav badge updates from any
  // page while files are being uploaded.
  const uploads = useUploads();
  const uploadInProgress = uploads.filter(
    (u) =>
      u.phase === "queued" ||
      u.phase === "uploading" ||
      u.phase === "consuming" ||
      u.phase === "ai",
  ).length;
  const uploadsActive = isUploadInFlight(uploads);
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

  // Live numbers win when SSE has delivered at least one event; otherwise
  // fall back to whatever the polled hooks have cached.
  const inboxCount = live.data?.inbox ?? inbox.data?.total ?? null;
  const inFlightCount = live.data?.in_flight ?? inFlight.data?.count ?? 0;
  const processingCount = Math.max(0, inFlightCount - (inboxCount ?? 0));
  const trashTotal = live.data?.trash ?? trashCount.data?.total ?? 0;

  // Desktop nav is icon-only: each item is a 36px square button with a
  // native tooltip (title) + aria-label for screen readers. Active state
  // is a raised pill rather than a font-weight bump so the row reads as a
  // single premium control strip.
  const iconCls = (key: NavKey) =>
    `relative inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
      active === key
        ? "bg-surface-raised text-ink"
        : "text-ink-muted hover:bg-surface-raised hover:text-ink"
    }`;

  const drawerLinkCls = (key: NavKey) =>
    `flex items-center justify-between rounded-md px-3 py-3 text-base transition-colors ${
      active === key
        ? "bg-surface-raised font-medium text-ink"
        : "text-ink-muted hover:bg-surface-raised hover:text-ink"
    }`;

  // Count badge anchored to the top-right of an icon button. The
  // ring-2 ring-canvas punches a clean gap between badge and icon.
  const iconBadge = (tone: "amber" | "zinc") =>
    `absolute -right-1 -top-1 inline-flex min-w-[1.05rem] justify-center rounded-full px-1 py-px text-[10px] font-semibold leading-tight text-white ring-2 ring-canvas ${
      tone === "amber" ? "bg-amber-500" : "bg-zinc-500"
    }`;
  // Drawer badges keep the original inline-pill look (text labels remain).
  const badgeAmber =
    "inline-flex min-w-[1.25rem] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white";
  const badgeZinc =
    "inline-flex min-w-[1.25rem] justify-center rounded-full bg-zinc-500 px-1.5 py-0.5 text-[10px] font-semibold text-white";

  const divider = (
    <span className="mx-1.5 h-5 w-px bg-hairline" aria-hidden />
  );

  return (
    <header className="relative border-b border-hairline bg-canvas">
      <div className="flex items-center justify-between px-4 py-2 md:px-6">
        {/* Brand + desktop nav */}
        <div className="flex min-w-0 items-center gap-5">
          <Link
            to="/"
            className="text-sm font-semibold tracking-tight text-ink"
            onClick={() => setMenuOpen(false)}
          >
            aktenraum
          </Link>
          <nav className="hidden items-center gap-0.5 md:flex">
            <Link to="/" className={iconCls("home")} title="Start" aria-label="Start">
              <HomeIcon className="h-[18px] w-[18px]" />
            </Link>
            <Link to="/ask" className={iconCls("ask")} title="Ask AI" aria-label="Ask AI">
              <SparklesIcon className="h-[18px] w-[18px]" />
            </Link>
            <Link
              to="/library"
              search={{ tab: "archive" }}
              className={iconCls("library")}
              title="Bibliothek"
              aria-label="Bibliothek"
            >
              <LibraryIcon className="h-[18px] w-[18px]" />
              {inboxCount !== null && inboxCount > 0 && (
                <span title="Dokumente zur Prüfung" className={iconBadge("amber")}>
                  {inboxCount}
                </span>
              )}
            </Link>

            {divider}

            <Link to="/upload" className={iconCls("upload")} title="Hochladen" aria-label="Hochladen">
              <UploadIcon className="h-[18px] w-[18px]" />
            </Link>
            <Link to="/scan" className={iconCls("scan")} title="Scannen" aria-label="Scannen">
              <CameraIcon className="h-[18px] w-[18px]" />
            </Link>

            {divider}

            <Link to="/trash" className={iconCls("trash")} title="Papierkorb" aria-label="Papierkorb">
              <TrashIcon className="h-[18px] w-[18px]" />
              {trashTotal > 0 && (
                <span title="Im Papierkorb" className={iconBadge("zinc")}>
                  {trashTotal}
                </span>
              )}
            </Link>
            <Link to="/settings" className={iconCls("settings")} title="Einstellungen" aria-label="Einstellungen">
              <SettingsIcon className="h-[18px] w-[18px]" />
            </Link>
          </nav>
        </div>

        {/* Desktop right side */}
        <div className="hidden items-center gap-3 text-sm text-ink-muted md:flex">
          {uploadsActive && (
            <Link
              to="/upload"
              title="Uploads laufen — klicken zum Fortschritt"
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-xs text-sky-700 hover:bg-sky-500/15"
            >
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-600"
                aria-hidden
              />
              {uploadInProgress} Uploads
            </Link>
          )}
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
              <span className="flex items-center gap-3">
                <HomeIcon className="h-[18px] w-[18px]" />
                <span>Start</span>
              </span>
            </Link>
            <Link to="/ask" className={drawerLinkCls("ask")} onClick={() => setMenuOpen(false)}>
              <span className="flex items-center gap-3">
                <SparklesIcon className="h-[18px] w-[18px]" />
                <span>Ask AI</span>
              </span>
            </Link>
            <Link
              to="/library"
              search={{ tab: "archive" }}
              className={drawerLinkCls("library")}
              onClick={() => setMenuOpen(false)}
            >
              <span className="flex items-center gap-3">
                <LibraryIcon className="h-[18px] w-[18px]" />
                <span>Bibliothek</span>
              </span>
              {inboxCount !== null && inboxCount > 0 && (
                <span className={badgeAmber}>{inboxCount}</span>
              )}
            </Link>
            <Link to="/upload" className={drawerLinkCls("upload")} onClick={() => setMenuOpen(false)}>
              <span className="flex items-center gap-3">
                <UploadIcon className="h-[18px] w-[18px]" />
                <span>Hochladen</span>
              </span>
            </Link>
            <Link to="/scan" className={drawerLinkCls("scan")} onClick={() => setMenuOpen(false)}>
              <span className="flex items-center gap-3">
                <CameraIcon className="h-[18px] w-[18px]" />
                <span>Scannen</span>
              </span>
            </Link>
            <Link to="/trash" className={drawerLinkCls("trash")} onClick={() => setMenuOpen(false)}>
              <span className="flex items-center gap-3">
                <TrashIcon className="h-[18px] w-[18px]" />
                <span>Papierkorb</span>
              </span>
              {trashTotal > 0 && <span className={badgeZinc}>{trashTotal}</span>}
            </Link>
            <Link to="/settings" className={drawerLinkCls("settings")} onClick={() => setMenuOpen(false)}>
              <span className="flex items-center gap-3">
                <SettingsIcon className="h-[18px] w-[18px]" />
                <span>Einstellungen</span>
              </span>
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
