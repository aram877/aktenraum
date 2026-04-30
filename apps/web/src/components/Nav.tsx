import { Link, useNavigate } from "@tanstack/react-router";

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

  const onLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  const linkCls = (key: typeof active, slug: string) =>
    `text-sm ${
      active === key
        ? "font-medium text-neutral-900"
        : "text-neutral-600 hover:text-neutral-900"
    }${slug ? "" : ""}`;

  const inboxCount = inbox.data?.total ?? null;

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
      <div className="flex items-center gap-6">
        <Link to="/" className="text-sm font-semibold tracking-tight">
          aktenraum
        </Link>
        <nav className="flex items-center gap-4">
          <Link to="/" className={linkCls("home", "")}>
            Start
          </Link>
          <Link to="/ask" className={linkCls("ask", "")}>
            Ask AI
          </Link>
          <Link to="/find" className={linkCls("find", "")}>
            Dokumente finden
          </Link>
          <Link to="/library" className={linkCls("library", "")}>
            Bibliothek
          </Link>
          <Link to="/upload" className={linkCls("upload", "")}>
            + Hochladen
          </Link>
          <Link to="/inbox" className={`${linkCls("inbox", "")} flex items-center gap-1.5`}>
            <span>Inbox</span>
            {inboxCount !== null && inboxCount > 0 && (
              <span className="inline-flex min-w-[1.25rem] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {inboxCount}
              </span>
            )}
          </Link>
        </nav>
      </div>
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
  );
}
