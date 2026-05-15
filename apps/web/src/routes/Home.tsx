import { Link } from "@tanstack/react-router";

import { Nav } from "../components/Nav";

export function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <Nav active="home" />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Willkommen im aktenraum.
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            Dein KI-gestütztes Dokumentenarchiv. Hochladen, finden, verstehen.
          </p>

          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link
              to="/ask"
              className="group flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface p-5 transition-colors hover:border-accent/40 hover:bg-surface"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-accent">
                KI-Assistent
              </span>
              <span className="text-sm font-medium text-ink">Ask AI →</span>
              <span className="text-xs text-ink-subtle">
                Stelle Fragen zu deinen Dokumenten in natürlicher Sprache.
              </span>
            </Link>

            <Link
              to="/find"
              className="group flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface p-5 transition-colors hover:border-hairline-soft hover:bg-surface"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                Suche
              </span>
              <span className="text-sm font-medium text-ink">Dokumente finden →</span>
              <span className="text-xs text-ink-subtle">
                Filtere nach Typ, Korrespondent oder Zeitraum.
              </span>
            </Link>

            <Link
              to="/library"
              className="group flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface p-5 transition-colors hover:border-hairline-soft hover:bg-surface"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                Archiv
              </span>
              <span className="text-sm font-medium text-ink">Bibliothek →</span>
              <span className="text-xs text-ink-subtle">
                Alle klassifizierten Dokumente durchsuchen.
              </span>
            </Link>

            <Link
              to="/upload"
              className="group flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface p-5 transition-colors hover:border-hairline-soft hover:bg-surface"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                Eingang
              </span>
              <span className="text-sm font-medium text-ink">+ Hochladen</span>
              <span className="text-xs text-ink-subtle">
                PDF oder Bild hochladen — KI klassifiziert automatisch.
              </span>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
