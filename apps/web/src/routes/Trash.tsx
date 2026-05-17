import { useState } from "react";

import { Nav } from "../components/Nav";
import {
  trashDaysRemaining,
  useDeleteForever,
  useEmptyTrash,
  useRestoreFromTrash,
  useTrashList,
  type TrashItem,
} from "../lib/trash";

export function Trash() {
  const list = useTrashList({ pageSize: 50 });
  const empty = useEmptyTrash();
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const total = list.data?.total ?? 0;
  const rows = list.data?.results ?? [];

  const onEmptyConfirm = async () => {
    try {
      const result = await empty.mutateAsync();
      setToast(`${result.emptied} Dokument(e) endgültig gelöscht`);
      window.setTimeout(() => setToast(null), 4000);
    } catch {
      setToast("Papierkorb konnte nicht geleert werden");
      window.setTimeout(() => setToast(null), 4000);
    } finally {
      setConfirmingEmpty(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <Nav active="trash" />
      <main className="mx-auto w-full max-w-6xl px-6 py-8">
        <header className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">Papierkorb</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Dokumente sind 30 Tage wiederherstellbar, dann werden sie
              automatisch endgültig gelöscht.
            </p>
          </div>
          {total > 0 && (
            <button
              onClick={() => setConfirmingEmpty(true)}
              disabled={empty.isPending}
              className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Papierkorb leeren
            </button>
          )}
        </header>

        {list.isLoading && (
          <p className="text-sm text-ink-subtle">Lade Papierkorb…</p>
        )}

        {list.isError && (
          <p className="text-sm text-red-700">
            Papierkorb konnte nicht geladen werden:{" "}
            {list.error?.message ?? "Unbekannter Fehler"}
          </p>
        )}

        {!list.isLoading && !list.isError && rows.length === 0 && (
          <div className="rounded-md border border-hairline bg-surface p-8 text-center text-sm text-ink-muted">
            Papierkorb ist leer
          </div>
        )}

        {rows.length > 0 && (
          <ul className="divide-y divide-hairline rounded-md border border-hairline bg-surface">
            {rows.map((row) => (
              <TrashRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </main>

      {confirmingEmpty && (
        <ConfirmEmptyModal
          count={total}
          pending={empty.isPending}
          onCancel={() => setConfirmingEmpty(false)}
          onConfirm={onEmptyConfirm}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-ink px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function TrashRow({ row }: { row: TrashItem }) {
  const restore = useRestoreFromTrash();
  const deleteForever = useDeleteForever();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const daysLeft = trashDaysRemaining(row.deleted_at);
  const correspondent = row.correspondent ?? row.ai_correspondent ?? "—";
  const docType = row.document_type ?? row.ai_document_type ?? "—";

  const onRestore = async () => {
    try {
      await restore.mutateAsync(row.id);
    } catch {
      /* surface via the inline error below */
    }
  };

  const onDeleteForever = async () => {
    try {
      await deleteForever.mutateAsync(row.id);
    } catch {
      /* surface via the inline error below */
    } finally {
      setConfirmingDelete(false);
    }
  };

  const error =
    restore.error?.message ?? deleteForever.error?.message ?? null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{row.title}</p>
        <p className="mt-0.5 truncate text-xs text-ink-subtle">
          {correspondent} · {docType}
          {daysLeft !== null && (
            <span className="ml-2 text-ink-muted">noch {daysLeft} Tage</span>
          )}
        </p>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onRestore}
          disabled={restore.isPending || deleteForever.isPending}
          className="rounded-md border border-hairline bg-white px-3 py-1 text-xs text-ink hover:bg-canvas disabled:opacity-50"
        >
          {restore.isPending ? "…" : "Wiederherstellen"}
        </button>
        {!confirmingDelete ? (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={restore.isPending || deleteForever.isPending}
            className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Endgültig löschen
          </button>
        ) : (
          <>
            <button
              onClick={() => setConfirmingDelete(false)}
              disabled={deleteForever.isPending}
              className="rounded-md border border-hairline bg-white px-3 py-1 text-xs text-ink-muted hover:bg-canvas disabled:opacity-50"
            >
              Abbrechen
            </button>
            <button
              onClick={onDeleteForever}
              disabled={deleteForever.isPending}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleteForever.isPending ? "…" : "Ja, endgültig löschen"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function ConfirmEmptyModal({
  count,
  pending,
  onCancel,
  onConfirm,
}: {
  count: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-ink">
          Papierkorb leeren?
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          {count === 1
            ? "1 Dokument wird endgültig gelöscht. Dies kann nicht rückgängig gemacht werden."
            : `${count} Dokumente werden endgültig gelöscht. Dies kann nicht rückgängig gemacht werden.`}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-hairline bg-white px-3 py-1.5 text-sm text-ink-muted hover:bg-canvas disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pending ? "Lösche…" : "Ja, alle endgültig löschen"}
          </button>
        </div>
      </div>
    </div>
  );
}
