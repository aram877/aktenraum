import { Link } from "@tanstack/react-router";

import { Nav } from "../components/Nav";

export function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <Nav active="home" />
      <main className="flex-1 px-6 py-12 text-neutral-600">
        <p className="text-sm">Willkommen im aktenraum.</p>
        <div className="mt-4 flex gap-3">
          <Link
            to="/ask"
            className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            Ask AI →
          </Link>
          <Link
            to="/inbox"
            className="inline-block rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
          >
            Inbox prüfen →
          </Link>
        </div>
      </main>
    </div>
  );
}
