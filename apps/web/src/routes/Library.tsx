import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Nav } from "../components/Nav";
import { ProcessingBadge } from "../components/ProcessingBadge";
import type { LibraryOrdering } from "../router";
import type { LibraryItem, LibraryQuery, TagFacet } from "../lib/library";
import { DOC_TYPES, useLibrary, useTagFacet } from "../lib/library";
import {
  isInFlight,
  useBulkReprocess,
  useProcessingState,
} from "../lib/documents";
import type { InboxItem } from "../lib/inbox";
import { useBulkApprove, useInboxList, useInboxListInfinite } from "../lib/inbox";

const DEFAULT_PAGE_SIZE = 25;

type Search = {
  tab?: "review" | "archive";
  document_type?: string;
  correspondent?: string;
  date_from?: string;
  date_to?: string;
  text?: string;
  tags?: string[];
  page?: number;
  ordering?: LibraryOrdering;
};

type LocalForm = {
  document_type: string;
  correspondent: string;
  date_from: string;
  date_to: string;
  text: string;
};

function searchToForm(s: Search): LocalForm {
  return {
    document_type: s.document_type ?? "",
    correspondent: s.correspondent ?? "",
    date_from: s.date_from ?? "",
    date_to: s.date_to ?? "",
    text: s.text ?? "",
  };
}

function formToSearch(
  f: LocalForm,
  page: number,
  tags: string[] | undefined,
): Search {
  const out: Search = {};
  if (f.document_type) out.document_type = f.document_type;
  if (f.correspondent) out.correspondent = f.correspondent;
  if (f.date_from) out.date_from = f.date_from;
  if (f.date_to) out.date_to = f.date_to;
  if (f.text) out.text = f.text;
  if (tags && tags.length > 0) out.tags = tags;
  if (page > 1) out.page = page;
  return out;
}

export function Library({ search }: { search: Search }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<LocalForm>(() => searchToForm(search));
  const facet = useTagFacet();

  const lastSearchRef = useRef(search);
  useEffect(() => {
    if (JSON.stringify(lastSearchRef.current) !== JSON.stringify(search)) {
      lastSearchRef.current = search;
      setForm(searchToForm(search));
    }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = formToSearch(form, 1, search.tags);
      if (search.tab) next.tab = search.tab;
      const current = { ...search };
      delete current.page;
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        void navigate({ to: "/library", search: next });
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const ordering = search.ordering ?? "-created";
  const query = useMemo<LibraryQuery>(
    () => ({
      ...search,
      page: search.page ?? 1,
      page_size: DEFAULT_PAGE_SIZE,
      ordering,
    }),
    [search, ordering],
  );
  const list = useLibrary(query);
  const processing = useProcessingState();

  const onResetFilters = () => {
    setForm(searchToForm({}));
    void navigate({ to: "/library", search: search.tab ? { tab: search.tab } : {} });
  };

  const goToPage = (page: number) => {
    void navigate({
      to: "/library",
      search: { ...search, page: page > 1 ? page : undefined },
    });
  };

  const toggleTag = (tag: string) => {
    const current = search.tags ?? [];
    const next = current.includes(tag)
      ? current.filter((t) => t !== tag)
      : [...current, tag];
    void navigate({
      to: "/library",
      search: {
        ...search,
        tags: next.length > 0 ? next : undefined,
        page: undefined,
      },
    });
  };

  const total = list.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const currentPage = search.page ?? 1;
  const errorDetail = list.error?.response?.data?.detail ?? list.error?.message;

  const tab = search.tab ?? "archive";

  // Pending-review count for the tab badge. Same query the Nav uses
  // (pageSize:1, just to read .total), so TanStack Query dedups and the
  // two badges stay in sync without an extra round trip.
  const inboxStats = useInboxList({ pageSize: 1 });
  const reviewCount = inboxStats.data?.total ?? null;

  // ----- Bulk reprocess (archive tab only) -----
  const bulkReprocess = useBulkReprocess();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkResult, setBulkResult] = useState<{
    succeeded: number;
    failed: number;
  } | null>(null);

  const visibleIds = useMemo(
    () => list.data?.results.map((r) => r.id) ?? [],
    [list.data],
  );

  const effectiveSelected = useMemo(() => {
    if (!visibleIds.length) return selected;
    const visible = new Set(visibleIds);
    let pruned = false;
    const next = new Set<number>();
    selected.forEach((id) => {
      if (visible.has(id)) next.add(id);
      else pruned = true;
    });
    return pruned ? next : selected;
  }, [selected, visibleIds]);

  const selectedCount = effectiveSelected.size;
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => effectiveSelected.has(id));

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(visibleIds));
  };

  const onBulkReprocess = async () => {
    const ids = Array.from(effectiveSelected);
    if (ids.length === 0) return;
    setBulkResult(null);
    const res = await bulkReprocess.mutateAsync(ids);
    setBulkResult({ succeeded: res.succeeded.length, failed: res.failed.length });
    setSelected((prev) => {
      const next = new Set(prev);
      res.succeeded.forEach((id) => next.delete(id));
      return next;
    });
  };

  const tabCls = (t: "review" | "archive") =>
    `px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
      tab === t
        ? "border-ink text-ink"
        : "border-transparent text-ink-muted hover:text-ink"
    }`;

  return (
    <div className="flex min-h-full flex-col">
      <Nav active="library" />

      {/* Tabs */}
      <div className="border-b border-hairline bg-canvas px-4 md:px-6">
        <nav className="flex gap-1">
          <button
            onClick={() => navigate({ to: "/library", search: { tab: "review" } })}
            className={`${tabCls("review")} inline-flex items-center gap-1.5`}
          >
            <span>Zur Prüfung</span>
            {reviewCount !== null && reviewCount > 0 && (
              <span
                title="Dokumente zur Prüfung"
                className="inline-flex min-w-[1.25rem] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
              >
                {reviewCount}
              </span>
            )}
          </button>
          <button
            onClick={() =>
              navigate({
                to: "/library",
                search: (prev) => ({ ...prev, tab: "archive" }),
              })
            }
            className={tabCls("archive")}
          >
            Archiv
          </button>
        </nav>
      </div>

      {tab === "review" ? (
        <ZurPruefungTab />
      ) : (
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4 md:flex-row md:gap-6 md:px-6 md:py-6">
          <FilterSidebar>
            <div className="rounded-lg border border-hairline bg-surface p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Filter
              </h2>
              <div className="mt-3 space-y-3">
                <Field label="Dokumenttyp">
                  <select
                    value={form.document_type}
                    onChange={(e) =>
                      setForm({ ...form, document_type: e.target.value })
                    }
                    className={inputCls}
                  >
                    <option value="">Alle</option>
                    {DOC_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Korrespondent">
                  <input
                    type="text"
                    value={form.correspondent}
                    onChange={(e) =>
                      setForm({ ...form, correspondent: e.target.value })
                    }
                    placeholder="Name eingeben"
                    className={inputCls}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Von">
                    <input
                      type="date"
                      value={form.date_from}
                      onChange={(e) =>
                        setForm({ ...form, date_from: e.target.value })
                      }
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Bis">
                    <input
                      type="date"
                      value={form.date_to}
                      onChange={(e) =>
                        setForm({ ...form, date_to: e.target.value })
                      }
                      className={inputCls}
                    />
                  </Field>
                </div>
                <Field label="Stichwort">
                  <input
                    type="text"
                    value={form.text}
                    onChange={(e) => setForm({ ...form, text: e.target.value })}
                    placeholder="Volltextsuche"
                    className={inputCls}
                  />
                </Field>
                <Field label="Sortierung">
                  <select
                    value={ordering}
                    onChange={(e) => {
                      const next = e.target.value;
                      void navigate({
                        to: "/library",
                        search: {
                          ...search,
                          // Drop the param when the user picks the
                          // default so the URL stays clean.
                          ordering:
                            next === "-created"
                              ? undefined
                              : (next as LibraryOrdering),
                          page: undefined,
                        },
                      });
                    }}
                    className={inputCls}
                  >
                    <option value="-created">Erstellt (neueste zuerst)</option>
                    <option value="created">Erstellt (älteste zuerst)</option>
                    <option value="-modified">Geändert (neueste zuerst)</option>
                    <option value="modified">Geändert (älteste zuerst)</option>
                    <option value="title">Titel (A → Z)</option>
                    <option value="-title">Titel (Z → A)</option>
                  </select>
                </Field>
                <button
                  type="button"
                  onClick={onResetFilters}
                  className="mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-raised"
                >
                  Filter zurücksetzen
                </button>
              </div>
            </div>

            <TagFacetPanel
              facet={facet.data?.results}
              isLoading={facet.isLoading}
              selected={search.tags ?? []}
              onToggle={toggleTag}
            />
          </FilterSidebar>

          <section className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between">
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                Bibliothek
              </h1>
              <span className="text-sm text-ink-subtle">
                {list.isLoading ? "…" : `${total} Dokumente`}
              </span>
            </div>

            {(search.tags ?? []).length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Aktive Tags
                </span>
                {(search.tags ?? []).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-0.5 text-xs text-emerald-800 hover:bg-emerald-100"
                    title="Tag entfernen"
                  >
                    {tag}
                    <span aria-hidden className="text-emerald-500">×</span>
                  </button>
                ))}
              </div>
            )}

            {errorDetail && (
              <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errorDetail}
              </p>
            )}

            {list.data && list.data.results.length === 0 && !list.isLoading && (
              <div className="mt-6 rounded-lg border border-dashed border-hairline bg-surface p-8 text-center text-sm text-ink-subtle">
                Keine Treffer für diese Filter.
              </div>
            )}

            {list.data && list.data.results.length > 0 && (
              <>
                {selectedCount > 0 && (
                  <div className="sticky top-0 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-inverse/20 bg-inverse px-4 py-2 text-sm text-on-inverse">
                    <span>
                      {selectedCount}{" "}
                      {selectedCount === 1
                        ? "Dokument ausgewählt"
                        : "Dokumente ausgewählt"}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelected(new Set())}
                        disabled={bulkReprocess.isPending}
                        className="rounded-md border border-white/20 px-3 py-1 text-xs text-on-inverse/80 hover:bg-white/10 disabled:opacity-60"
                      >
                        Auswahl aufheben
                      </button>
                      <button
                        type="button"
                        onClick={onBulkReprocess}
                        disabled={bulkReprocess.isPending}
                        className="rounded-md bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-60"
                      >
                        {bulkReprocess.isPending
                          ? "Stoße neu an…"
                          : `${selectedCount} erneut verarbeiten`}
                      </button>
                    </div>
                  </div>
                )}

                {bulkResult && (
                  <p
                    className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                      bulkResult.failed
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800"
                    }`}
                  >
                    {bulkResult.succeeded} neu angestoßen
                    {bulkResult.failed
                      ? ` · ${bulkResult.failed} fehlgeschlagen`
                      : ""}
                    .
                  </p>
                )}

                {/* Desktop table */}
                <div className="mt-4 hidden rounded-lg border border-hairline bg-surface md:block">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-hairline text-xs uppercase tracking-wide text-ink-subtle">
                      <tr>
                        <th className="w-8 px-3 py-2.5">
                          <input
                            type="checkbox"
                            aria-label="Alle auswählen"
                            checked={allSelected}
                            onChange={toggleAll}
                            className="h-4 w-4 cursor-pointer accent-ink"
                          />
                        </th>
                        <th className="px-3 py-2.5">Titel</th>
                        <th className="px-3 py-2.5">Typ</th>
                        <th className="px-3 py-2.5">Korrespondent</th>
                        <th className="px-3 py-2.5">Datum</th>
                        <th className="px-3 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline-soft">
                      {list.data.results.map((row) => (
                        <Row
                          key={row.id}
                          row={row}
                          selectedTags={search.tags ?? []}
                          onTagClick={toggleTag}
                          checked={effectiveSelected.has(row.id)}
                          onToggle={() => toggleOne(row.id)}
                          // Two complementary signals for "worker is on
                          // this doc right now": the server's pin flag
                          // (authoritative, always set on prepended
                          // rows) and the SPA-polled /processing state
                          // (catches natural-sort rows whose worker
                          // started after the page-1 fetch).
                          inFlight={
                            row.is_processing ||
                            isInFlight(row.id, processing.data)
                          }
                          onClick={() =>
                            navigate({
                              to: "/library/$id",
                              params: { id: String(row.id) },
                            })
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <ul className="mt-4 space-y-2 md:hidden">
                  {list.data.results.map((row) => (
                    <LibraryCard
                      key={row.id}
                      row={row}
                      selectedTags={search.tags ?? []}
                      onTagClick={toggleTag}
                      checked={effectiveSelected.has(row.id)}
                      onToggle={() => toggleOne(row.id)}
                      inFlight={
                        row.is_processing ||
                        isInFlight(row.id, processing.data)
                      }
                      onOpen={() =>
                        navigate({
                          to: "/library/$id",
                          params: { id: String(row.id) },
                        })
                      }
                    />
                  ))}
                </ul>
              </>
            )}

            {lastPage > 1 && (
              <div className="mt-4 flex items-center justify-end gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-ink-muted hover:bg-canvas disabled:opacity-50"
                >
                  ← Zurück
                </button>
                <span className="text-xs text-ink-subtle">
                  Seite {currentPage} / {lastPage}
                </span>
                <button
                  type="button"
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage >= lastPage}
                  className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-ink-muted hover:bg-canvas disabled:opacity-50"
                >
                  Weiter →
                </button>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function TagFacetPanel({
  facet,
  isLoading,
  selected,
  onToggle,
}: {
  facet: TagFacet[] | undefined;
  isLoading: boolean;
  selected: string[];
  onToggle: (tag: string) => void;
}) {
  return (
    <div className="mt-4 rounded-lg border border-hairline bg-surface p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        Tags
      </h2>
      {isLoading && (
        <p className="mt-2 text-xs text-ink-subtle">Lade Tags…</p>
      )}
      {!isLoading && facet && facet.length === 0 && (
        <p className="mt-2 text-xs text-ink-subtle">
          Noch keine Tags mit ≥2 Dokumenten.
        </p>
      )}
      {facet && facet.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {facet.map((t) => {
            const active = selected.includes(t.name);
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => onToggle(t.name)}
                className={
                  active
                    ? "inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800"
                    : "inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas px-2.5 py-1 text-xs text-ink-muted hover:border-hairline-soft hover:bg-surface-raised"
                }
                title={
                  active
                    ? `Tag '${t.name}' aktiv — klicken zum Entfernen`
                    : `Tag '${t.name}' anwenden`
                }
              >
                <span>{t.name}</span>
                <span className={active ? "text-emerald-600" : "text-ink-faint"}>
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  selectedTags,
  onTagClick,
  checked,
  onToggle,
  inFlight,
  onClick,
}: {
  row: LibraryItem;
  selectedTags: string[];
  onTagClick: (tag: string) => void;
  checked: boolean;
  onToggle: () => void;
  inFlight: boolean;
  onClick: () => void;
}) {
  return (
    <tr className="hover:bg-canvas">
      <td className="w-8 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`${row.title} auswählen`}
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 cursor-pointer accent-ink"
        />
      </td>
      <td onClick={onClick} className="cursor-pointer px-3 py-2.5">
        <div className="font-medium text-ink">{row.title}</div>
        {row.original_file_name && row.original_file_name !== row.title && (
          <div className="text-[10px] text-ink-faint">
            Original: {row.original_file_name}
          </div>
        )}
        {row.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.tags.slice(0, 5).map((t) => {
              const active = selectedTags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTagClick(t);
                  }}
                  className={
                    active
                      ? "rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-800"
                      : "rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[10px] text-ink-muted hover:bg-surface-raised"
                  }
                  title={`Auf Tag '${t}' filtern`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
      </td>
      <td onClick={onClick} className="cursor-pointer px-3 py-2.5 text-ink-muted">
        {row.document_type ?? "—"}
      </td>
      <td onClick={onClick} className="cursor-pointer px-3 py-2.5 text-ink-muted">
        {row.correspondent ?? "—"}
      </td>
      <td onClick={onClick} className="cursor-pointer px-3 py-2.5 text-ink-muted">
        {row.created ?? "—"}
      </td>
      <td onClick={onClick} className="cursor-pointer px-3 py-2.5">
        <ProcessingBadge
          tags={row.lifecycle_tags}
          errorMessage={row.ai_error_message}
          inFlight={inFlight}
        />
      </td>
    </tr>
  );
}

function FilterSidebar({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <aside className="w-full shrink-0 md:w-60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-hairline bg-surface px-3 py-2 text-sm text-ink-muted md:hidden"
      >
        <span className="font-medium">Filter &amp; Tags</span>
        <span aria-hidden className="text-xs">
          {open ? "▴" : "▾"}
        </span>
      </button>
      <div className={`${open ? "mt-2 block" : "hidden"} md:mt-0 md:block`}>
        {children}
      </div>
    </aside>
  );
}

function LibraryCard({
  row,
  selectedTags,
  onTagClick,
  checked,
  onToggle,
  inFlight,
  onOpen,
}: {
  row: LibraryItem;
  selectedTags: string[];
  onTagClick: (tag: string) => void;
  checked: boolean;
  onToggle: () => void;
  inFlight: boolean;
  onOpen: () => void;
}) {
  return (
    <li className="rounded-lg border border-hairline bg-surface p-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`${row.title} auswählen`}
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-ink"
        />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-sm font-medium text-ink">
            {row.title}
          </div>
          {row.original_file_name && row.original_file_name !== row.title && (
            <div className="truncate text-[10px] text-ink-faint">
              Original: {row.original_file_name}
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            {row.document_type && <span>{row.document_type}</span>}
            {row.correspondent && (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span>{row.correspondent}</span>
              </>
            )}
            {row.created && (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span>{row.created}</span>
              </>
            )}
          </div>
          <div className="mt-2">
            <ProcessingBadge
              tags={row.lifecycle_tags}
              errorMessage={row.ai_error_message}
              inFlight={inFlight}
            />
          </div>
        </button>
      </div>
      {row.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {row.tags.slice(0, 5).map((t) => {
            const active = selectedTags.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick(t);
                }}
                className={
                  active
                    ? "rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800"
                    : "rounded-full border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-ink-muted"
                }
              >
                {t}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

const inputCls =
  "mt-1 block w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-medium text-ink-muted">
      {label}
      {children}
    </label>
  );
}

function ZurPruefungTab() {
  const navigate = useNavigate();
  const list = useInboxListInfinite({ pageSize: 50, ordering: "-modified" });
  const bulkApprove = useBulkApprove();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lastResult, setLastResult] = useState<{
    succeeded: number;
    failed: number;
  } | null>(null);

  const rows = useMemo<InboxItem[]>(
    () => list.data?.pages.flatMap((p) => p.results) ?? [],
    [list.data],
  );
  const total = list.data?.pages[0]?.total ?? 0;
  const loaded = rows.length;

  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);

  const effectiveSelected = useMemo(() => {
    if (!visibleIds.length) return selected;
    const visible = new Set(visibleIds);
    let pruned = false;
    const next = new Set<number>();
    selected.forEach((id) => {
      if (visible.has(id)) next.add(id);
      else pruned = true;
    });
    return pruned ? next : selected;
  }, [selected, visibleIds]);

  const selectedCount = effectiveSelected.size;
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => effectiveSelected.has(id));

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(visibleIds));
  };

  const onBulkApprove = async () => {
    const ids = Array.from(effectiveSelected);
    if (ids.length === 0) return;
    setLastResult(null);
    const res = await bulkApprove.mutateAsync(ids);
    setLastResult({ succeeded: res.succeeded.length, failed: res.failed.length });
    setSelected((prev) => {
      const next = new Set(prev);
      res.succeeded.forEach((id) => next.delete(id));
      return next;
    });
  };

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-4 md:px-6 md:py-6">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            Zur Prüfung
          </h1>
          <p className="mt-0.5 text-xs text-ink-muted sm:text-sm">
            Dokumente warten auf Ihre Prüfung. Zuletzt geänderte zuerst.
          </p>
        </div>
        <span className="shrink-0 text-sm text-ink-subtle">
          {list.data ? `${total} offen` : "…"}
        </span>
      </div>

      {list.isError && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Konnte die Liste nicht laden.
        </p>
      )}

      {list.data && loaded === 0 && (
        <div className="mt-8 rounded-lg border border-dashed border-hairline bg-surface p-8 text-center text-sm text-ink-subtle">
          Keine offenen Dokumente.{" "}
          <Link to="/ask" className="font-medium text-ink underline">
            Suche stattdessen.
          </Link>
        </div>
      )}

      {list.data && loaded > 0 && (
        <>
          {selectedCount > 0 && (
            <div className="sticky top-0 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-inverse/20 bg-inverse px-4 py-2 text-sm text-on-inverse">
              <span>
                {selectedCount}{" "}
                {selectedCount === 1
                  ? "Dokument ausgewählt"
                  : "Dokumente ausgewählt"}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={bulkApprove.isPending}
                  className="rounded-md border border-white/20 px-3 py-1 text-xs text-on-inverse/80 hover:bg-white/10 disabled:opacity-60"
                >
                  Auswahl aufheben
                </button>
                <button
                  type="button"
                  onClick={onBulkApprove}
                  disabled={bulkApprove.isPending}
                  className="rounded-md bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-60"
                >
                  {bulkApprove.isPending
                    ? "Genehmige…"
                    : `${selectedCount} genehmigen`}
                </button>
              </div>
            </div>
          )}

          {lastResult && (
            <p
              className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                lastResult.failed
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              {lastResult.succeeded} genehmigt
              {lastResult.failed
                ? ` · ${lastResult.failed} fehlgeschlagen`
                : ""}
              .
            </p>
          )}

          <div className="mt-4 hidden rounded-lg border border-hairline bg-surface md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-hairline text-xs uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th className="w-8 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Alle auswählen"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="h-4 w-4 cursor-pointer accent-ink"
                    />
                  </th>
                  <th className="px-3 py-2.5">Titel</th>
                  <th className="px-3 py-2.5">Typ</th>
                  <th className="px-3 py-2.5">Korrespondent</th>
                  <th className="px-3 py-2.5">Datum</th>
                  <th className="px-3 py-2.5 text-right">Konfidenz</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline-soft">
                {rows.map((row) => (
                  <ReviewRow
                    key={row.id}
                    row={row}
                    checked={effectiveSelected.has(row.id)}
                    onToggle={() => toggleOne(row.id)}
                    onOpen={() =>
                      navigate({
                        to: "/inbox/$id",
                        params: { id: String(row.id) },
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="mt-4 space-y-2 md:hidden">
            {rows.map((row) => (
              <ReviewCard
                key={row.id}
                row={row}
                checked={effectiveSelected.has(row.id)}
                onToggle={() => toggleOne(row.id)}
                onOpen={() =>
                  navigate({
                    to: "/inbox/$id",
                    params: { id: String(row.id) },
                  })
                }
              />
            ))}
          </ul>

          {(list.hasNextPage || list.isFetchingNextPage) && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <span className="text-xs text-ink-subtle">
                {loaded} von {total} geladen
              </span>
              <button
                type="button"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage || !list.hasNextPage}
                className="rounded-md border border-hairline bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
              >
                {list.isFetchingNextPage ? "lade…" : "Mehr anzeigen"}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function ReviewRow({
  row,
  checked,
  onToggle,
  onOpen,
}: {
  row: InboxItem;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const flagCls = row.low_confidence ? "border-l-2 border-amber-400" : "";
  return (
    <tr className={`hover:bg-canvas ${flagCls}`}>
      <td className="w-8 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`${row.title} auswählen`}
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 cursor-pointer accent-ink"
        />
      </td>
      <td onClick={onOpen} className="cursor-pointer px-3 py-2.5 font-medium text-ink">
        {row.title}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-3 py-2.5 text-ink-muted">
        {row.ai_document_type ?? "—"}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-3 py-2.5 text-ink-muted">
        {row.ai_correspondent ?? "—"}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-3 py-2.5 text-ink-muted">
        {row.ai_issue_date ?? row.created ?? "—"}
      </td>
      <td onClick={onOpen} className="cursor-pointer px-3 py-2.5 text-right text-ink-muted">
        {row.ai_confidence != null
          ? `${Math.round(row.ai_confidence * 100)}%`
          : "—"}
      </td>
    </tr>
  );
}

function ReviewCard({
  row,
  checked,
  onToggle,
  onOpen,
}: {
  row: InboxItem;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const flagCls = row.low_confidence ? "border-l-2 border-amber-400" : "";
  return (
    <li className={`rounded-lg border border-hairline bg-surface p-3 ${flagCls}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={`${row.title} auswählen`}
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-ink"
        />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-sm font-medium text-ink">
            {row.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            {row.ai_document_type && <span>{row.ai_document_type}</span>}
            {row.ai_correspondent && (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span>{row.ai_correspondent}</span>
              </>
            )}
            {(row.ai_issue_date || row.created) && (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <span>{row.ai_issue_date ?? row.created}</span>
              </>
            )}
          </div>
        </button>
        {row.ai_confidence != null && (
          <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-medium text-ink-muted">
            {Math.round(row.ai_confidence * 100)}%
          </span>
        )}
      </div>
    </li>
  );
}
