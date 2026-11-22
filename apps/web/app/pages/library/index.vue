<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 400;
const TAG_SUGGESTIONS = 12;

const route = useRoute();

const filters = computed(() => {
  const q = route.query;
  const page = Number.parseInt(firstParam(q.page) || "1", 10);
  return {
    family: firstParam(q.family),
    document_type: firstParam(q.document_type),
    correspondent: firstParam(q.correspondent),
    date_from: firstParam(q.date_from),
    date_to: firstParam(q.date_to),
    text: firstParam(q.text),
    ordering: firstParam(q.ordering) || DEFAULT_ORDERING,
    tags: allParams(q.tags),
    status: libraryStatusParam(firstParam(q.status)),
    space: firstParam(q.space),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
});

const tab = computed(() => (firstParam(route.query.tab) === "review" ? "review" : "archive"));

const query = computed<LibraryQuery>(() => ({
  document_type: libraryTypeFilter(filters.value.family, filters.value.document_type),
  correspondent: filters.value.correspondent || null,
  date_from: filters.value.date_from || null,
  date_to: filters.value.date_to || null,
  text: filters.value.text || null,
  tags: filters.value.tags.length > 0 ? filters.value.tags : null,
  status: filters.value.status || null,
  space: filters.value.space || null,
  ordering: filters.value.ordering,
  page: filters.value.page,
  page_size: PAGE_SIZE,
}));

const library = useLibrary(query);
const facet = useTagFacet();
const typeFacet = useTypeFacet();
const reviewCount = useInboxList({ pageSize: 1 });
const reprocessFailed = useReprocessFailed();
const bulkConfirm = ref(false);
const bulkResult = ref<string | null>(null);

// Spaces ("Akten"): column, filter and bulk move only once the household has a second member.
const { spaces, visible: spacesVisible } = useSpacesVisible();
const mySpaces = computed(() => spaces.data.value?.spaces ?? []);
const moveTargets = computed(() => placeableSpaces(spaces.data.value));
const bulkMove = useBulkMove();
const selected = ref<ReadonlySet<number>>(new Set());
const moveTarget = ref<number | null>(null);
const moveResult = ref<string | null>(null);

const rows = computed<readonly LibraryItem[]>(() => library.data.value?.results ?? []);
const total = computed(() => library.data.value?.total ?? 0);
const pages = computed(() => totalPages(total.value, PAGE_SIZE));
const groups = computed(() => groupByMonth(rows.value, filters.value.ordering));
const errorText = computed(() =>
  library.isError.value ? detailFrom(library.error.value, "Laden fehlgeschlagen.") : null,
);

// --- area + type chips ------------------------------------------------------
const areas = computed(() => familyCounts(typeFacet.data.value?.results ?? []));
const allCount = computed(() => areas.value.reduce((sum, a) => sum + a.count, 0));
const activeArea = computed(() => {
  const explicit = filters.value.document_type ? familyOfType(filters.value.document_type).key : "";
  return areas.value.find((a) => a.family.key === (filters.value.family || explicit)) ?? null;
});

function pickArea(key: string): void {
  syncUrl({ family: filters.value.family === key ? "" : key, document_type: "", page: 1 });
}

function pickType(name: string): void {
  const family = familyOfType(name).key;
  syncUrl({ family, document_type: filters.value.document_type === name ? "" : name, page: 1 });
}

function chipStyle(fill: string | null, tint: string | null, ink: string | null, on: boolean): Record<string, string> {
  if (!on) return {};
  if (fill === null) return { backgroundColor: "var(--color-ink)", borderColor: "var(--color-ink)", color: "var(--color-canvas)" };
  return { backgroundColor: tint ?? "", borderColor: fill, color: ink ?? "" };
}

// --- "Weitere Filter" -------------------------------------------------------
const advancedActive = computed(() => {
  const f = filters.value;
  return Boolean(f.correspondent || f.date_from || f.date_to || f.space) || f.tags.length > 0;
});
const moreOpen = ref(false);
watch(advancedActive, (on) => {
  if (on) moreOpen.value = true;
}, { immediate: true });

const tagSearch = ref("");
const tagOptions = computed(() => {
  const all = facet.data.value?.results ?? [];
  const needle = tagSearch.value.trim().toLowerCase();
  const pool = needle ? all.filter((t) => t.name.toLowerCase().includes(needle)) : all;
  return [...pool].sort((a, b) => b.count - a.count).slice(0, TAG_SUGGESTIONS);
});

const hasActiveFilters = computed(() => {
  const f = filters.value;
  return Boolean(f.family || f.document_type || f.text || f.status) || advancedActive.value;
});

// --- selection for bulk move -------------------------------------------------
watch(query, () => {
  selected.value = new Set();
});

const allSelected = computed(() => rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.id)));

function toggleRow(id: number): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(rows.value.map((r) => r.id));
}

async function onBulkMove(): Promise<void> {
  const spaceId = moveTarget.value;
  if (spaceId === null || selected.value.size === 0) return;
  moveResult.value = null;
  try {
    const { results } = await bulkMove.mutateAsync({ spaceId, docIds: [...selected.value] });
    moveResult.value = summarizeMoves(results);
    selected.value = new Set(results.filter((r) => r.status !== "moved" && r.status !== "unchanged").map((r) => r.doc_id));
  } catch (error: unknown) {
    moveResult.value = detailFrom(error, "Verschieben fehlgeschlagen.");
  }
}

// --- preview panel (wide screens) ---------------------------------------------
const wide = ref(false);
let media: MediaQueryList | null = null;
function onMedia(): void {
  wide.value = media?.matches ?? false;
}
onMounted(() => {
  media = window.matchMedia("(min-width: 1024px)");
  onMedia();
  media.addEventListener("change", onMedia);
});

const previewId = ref<number | null>(null);
watch(rows, (next) => {
  if (!next.some((r) => r.id === previewId.value)) previewId.value = next[0]?.id ?? null;
}, { immediate: true });
const preview = useDocumentDetail(computed(() => (wide.value ? previewId.value : null)));
const previewRow = computed(() => rows.value.find((r) => r.id === previewId.value) ?? null);
const previewFields = computed(() => {
  const d = preview.data.value;
  if (!d || d.id !== previewId.value) return [];
  const out: { k: string; v: string }[] = [];
  for (const [key, value] of Object.entries(d.type_fields ?? {})) {
    if (value && out.length < 4) out.push({ k: key.replace(/_/g, " "), v: value });
  }
  if (d.ai_issue_date && out.length < 4) out.push({ k: "Ausgestellt", v: formatDocDate(d.ai_issue_date) });
  if (d.ai_confidence !== null && out.length < 4) out.push({ k: "KI-Sicherheit", v: `${Math.round(d.ai_confidence * 100)} %` });
  return out;
});

// Runs in the capture phase on the <li>, i.e. before the row link's own
// navigation handler: on wide screens a plain click only previews (the link
// sees `defaultPrevented` and stays put). Ctrl/Cmd/Shift/middle click and the
// checkbox keep their normal behaviour; double-click and "Öffnen" open.
function onRowClick(event: MouseEvent, id: number): void {
  if (!wide.value || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  if (!(event.target instanceof Element) || event.target.closest("a") === null) return;
  event.preventDefault();
  previewId.value = id;
}

function onRowDoubleClick(event: MouseEvent, id: number): void {
  if (!wide.value || !(event.target instanceof Element) || event.target.closest("a") === null) return;
  void navigateTo(`/library/${id}`);
}

// --- filters + URL ------------------------------------------------------------
const text = ref("");
const correspondent = ref("");
let debounceHandle: ReturnType<typeof setTimeout> | null = null;

watch(
  filters,
  (next) => {
    text.value = next.text;
    correspondent.value = next.correspondent;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (debounceHandle !== null) clearTimeout(debounceHandle);
  media?.removeEventListener("change", onMedia);
});

function syncUrl(patch: Record<string, unknown>): void {
  void navigateTo({ path: "/library", query: cleanLibraryQuery({ ...filters.value, ...patch }) });
}

function onFilterChange(patch: Record<string, unknown>): void {
  syncUrl({ ...patch, page: 1 });
}

function onStatusChange(value: string): void {
  bulkConfirm.value = false;
  bulkResult.value = null;
  if (value === REVIEW_STATUS) {
    switchTab("review");
    return;
  }
  onFilterChange({ status: value });
}

async function onBulkReprocess(): Promise<void> {
  if (!bulkConfirm.value) {
    bulkConfirm.value = true;
    return;
  }
  bulkConfirm.value = false;
  try {
    const result = await reprocessFailed.mutateAsync();
    const parts = [`${result.reprocessed} neu gestartet`];
    if (result.failed.length > 0) parts.push(`${result.failed.length} fehlgeschlagen`);
    if (result.remaining > 0) parts.push(`${result.remaining} weitere – erneut klicken`);
    bulkResult.value = parts.join(" · ");
  } catch (error: unknown) {
    bulkResult.value = detailFrom(error, "Erneut verarbeiten fehlgeschlagen.");
  }
}

function onTextInput(): void {
  if (debounceHandle !== null) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    syncUrl({ text: text.value, page: 1 });
  }, DEBOUNCE_MS);
}

function toggleTag(name: string): void {
  const current = filters.value.tags;
  const next = current.includes(name) ? current.filter((t) => t !== name) : [...current, name];
  syncUrl({ tags: next, page: 1 });
}

function switchTab(next: "archive" | "review"): void {
  void navigateTo({ path: "/library", query: next === "review" ? { tab: "review" } : {} });
}

function clearFilters(): void {
  tagSearch.value = "";
  void navigateTo({ path: "/library", query: {} });
}

function goToPage(next: number): void {
  if (next < 1 || next > pages.value) return;
  syncUrl({ page: next });
}

function valueOf(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value;
}

const STATUS_TONE: Record<string, string> = {
  danger: "#b42318",
  warning: "#a14b06",
  info: "#3f3f9a",
};

const fieldClass =
  "h-10 rounded-[10px] border border-hairline bg-surface px-3 text-sm text-ink focus:border-ink-faint focus:outline-none";
</script>

<template>
  <div class="mx-auto max-w-[1360px] px-4 pb-16 pt-8 sm:px-8 sm:pt-10">
    <div class="flex flex-wrap items-end gap-x-8 gap-y-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.08em] text-accent">
          {{ tab === "review" ? "Prüfen" : "Archiv" }}
        </p>
        <h1 class="mt-1.5 font-serif text-4xl font-medium leading-none tracking-[-0.02em] text-ink sm:text-5xl">
          Bibliothek
        </h1>
        <p v-if="tab === 'archive'" class="mt-2 text-sm text-ink-subtle" data-testid="library-total">
          {{ total }} {{ total === 1 ? "Dokument" : "Dokumente" }}
          <template v-if="activeArea"> · {{ activeArea.family.name }}</template>
        </p>
      </div>
      <div role="tablist" aria-label="Ansicht" class="ml-auto inline-flex rounded-xl bg-surface-sunken p-1">
        <button
          v-for="t in (['archive', 'review'] as const)"
          :key="t"
          type="button"
          role="tab"
          :aria-selected="tab === t"
          :data-testid="`tab-${t}`"
          class="h-9 rounded-[9px] px-4 text-sm font-medium"
          :class="tab === t ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(28,25,23,0.08)]' : 'text-ink-muted hover:text-ink'"
          @click="switchTab(t)"
        >
          {{ t === "archive" ? "Archiv" : "Zur Prüfung" }}
          <span
            v-if="t === 'review' && (reviewCount.data.value?.total ?? 0) > 0"
            class="ml-1 rounded-full bg-[#a14b06] px-1.5 py-px text-[11px] text-white"
          >{{ reviewCount.data.value?.total }}</span>
        </button>
      </div>
    </div>

    <LibraryReviewTab v-if="tab === 'review'" />
    <template v-else>
      <!-- areas -->
      <div class="mt-8 flex flex-wrap gap-2" data-testid="family-chips" aria-label="Nach Bereich filtern">
        <button
          type="button"
          class="inline-flex h-9 items-center gap-2 rounded-full border border-hairline bg-surface px-3.5 text-[13px] font-medium text-ink hover:border-ink-faint"
          :style="chipStyle(null, null, null, !activeArea)"
          :aria-pressed="!activeArea"
          @click="clearFilters"
        >
          Alle <span class="tabular opacity-70">{{ allCount }}</span>
        </button>
        <button
          v-for="a in areas"
          v-show="a.count > 0"
          :key="a.family.key"
          type="button"
          :data-testid="`family-${a.family.key}`"
          class="inline-flex h-9 items-center gap-2 rounded-full border border-hairline bg-surface px-3.5 text-[13px] font-medium text-ink hover:border-ink-faint"
          :style="chipStyle(a.family.fill, a.family.tint, a.family.ink, activeArea?.family.key === a.family.key)"
          :aria-pressed="activeArea?.family.key === a.family.key"
          @click="pickArea(a.family.key)"
        >
          <span class="h-2 w-2 rounded-[3px]" :style="{ backgroundColor: a.family.fill }" />
          {{ a.family.name }}
          <span class="tabular text-ink-subtle">{{ a.count }}</span>
        </button>
      </div>

      <!-- types of the chosen area -->
      <div v-if="activeArea && activeArea.types.length > 0" class="mt-3 flex flex-wrap gap-2" data-testid="type-facet">
        <button
          v-for="t in activeArea.types"
          :key="t.name"
          type="button"
          class="inline-flex h-8 items-center gap-2 rounded-full border bg-surface py-0 pl-1 pr-3 text-[13px] font-medium"
          :class="filters.document_type === t.name ? '' : 'border-hairline text-ink hover:border-ink-faint'"
          :style="chipStyle(activeArea.family.fill, activeArea.family.tint, activeArea.family.ink, filters.document_type === t.name)"
          @click="pickType(t.name)"
        >
          <DocTypeTile :type="t.name" size="sm" />
          {{ t.name }} <span class="tabular text-ink-subtle">{{ t.count }}</span>
        </button>
      </div>

      <!-- toolbar -->
      <div class="mt-5 flex flex-wrap items-center gap-2.5">
        <label class="flex h-10 min-w-0 flex-[1_1_280px] items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 text-ink-subtle focus-within:border-ink-faint">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <span class="sr-only">Volltext durchsuchen</span>
          <input
            v-model="text"
            type="search"
            name="text"
            placeholder="Titel, Inhalt, Korrespondent…"
            class="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            @input="onTextInput"
          >
        </label>
        <label class="sr-only" for="lib-status">Status</label>
        <select
          id="lib-status"
          name="status"
          :value="filters.status"
          :class="fieldClass"
          @change="onStatusChange(valueOf($event))"
        >
          <option v-for="opt in STATUS_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.value === "" ? "Status: alle" : opt.label }}
          </option>
        </select>
        <label class="sr-only" for="lib-ordering">Sortierung</label>
        <select
          id="lib-ordering"
          name="ordering"
          :value="filters.ordering"
          :class="fieldClass"
          @change="onFilterChange({ ordering: valueOf($event) })"
        >
          <option v-for="opt in ORDERING_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <button
          type="button"
          data-testid="more-filters"
          :aria-expanded="moreOpen"
          class="inline-flex h-10 items-center gap-2 rounded-[10px] border px-3.5 text-[13px] font-medium"
          :class="advancedActive ? 'border-ink bg-ink text-canvas' : 'border-hairline bg-surface text-ink hover:border-ink-faint'"
          @click="moreOpen = !moreOpen"
        >
          Weitere Filter
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path :d="moreOpen ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'" />
          </svg>
        </button>
        <button
          v-if="hasActiveFilters"
          type="button"
          class="h-10 px-2 text-[13px] font-medium text-accent hover:text-accent-dark"
          @click="clearFilters"
        >
          Zurücksetzen
        </button>
      </div>

      <div
        v-if="moreOpen"
        data-testid="more-filters-panel"
        class="mt-3 grid gap-4 rounded-2xl border border-hairline bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <label class="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
          Korrespondent
          <input
            v-model="correspondent"
            type="text"
            name="correspondent"
            :class="fieldClass"
            class="normal-case tracking-normal"
            @blur="onFilterChange({ correspondent })"
            @keydown.enter="onFilterChange({ correspondent })"
          >
        </label>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
            Von
            <input
              type="date"
              name="date_from"
              :value="filters.date_from"
              :class="fieldClass"
              class="px-2 normal-case tracking-normal"
              @change="onFilterChange({ date_from: valueOf($event) })"
            >
          </label>
          <label class="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
            Bis
            <input
              type="date"
              name="date_to"
              :value="filters.date_to"
              :class="fieldClass"
              class="px-2 normal-case tracking-normal"
              @change="onFilterChange({ date_to: valueOf($event) })"
            >
          </label>
        </div>
        <label
          v-if="spacesVisible"
          class="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle"
        >
          Akte
          <select
            name="space"
            data-testid="space-filter"
            :value="filters.space"
            :class="fieldClass"
            class="normal-case tracking-normal"
            @change="onFilterChange({ space: valueOf($event) })"
          >
            <option value="">Alle</option>
            <option v-for="s in mySpaces" :key="s.id" :value="String(s.id)">{{ spaceLabel(s) }}</option>
          </select>
        </label>
        <div class="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
          <label class="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle" for="lib-tag-search">Tags</label>
          <div class="flex flex-wrap items-center gap-1.5">
            <button
              v-for="t in filters.tags"
              :key="`on-${t}`"
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-xs font-medium text-canvas"
              :aria-label="`Tag ${t} entfernen`"
              @click="toggleTag(t)"
            >
              {{ t === "wichtig" ? "★ wichtig" : t }} <span aria-hidden="true">×</span>
            </button>
            <input
              id="lib-tag-search"
              v-model="tagSearch"
              type="search"
              placeholder="Tag suchen…"
              :class="fieldClass"
              class="h-8 w-44"
            >
            <button
              v-for="t in tagOptions"
              v-show="!filters.tags.includes(t.name)"
              :key="t.name"
              type="button"
              data-testid="tag-option"
              class="inline-flex h-8 items-center gap-1 rounded-full bg-surface-raised px-3 text-xs text-ink-muted hover:text-ink"
              @click="toggleTag(t.name)"
            >
              {{ t.name === "wichtig" ? "★ wichtig" : t.name }} <span class="tabular text-ink-faint">{{ t.count }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="mt-7 flex flex-wrap items-start gap-7">
        <section class="min-w-0 flex-[999_1_560px]" aria-label="Dokumente">
          <div
            v-if="filters.status === 'error' && (total > 0 || bulkResult)"
            class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
          >
            <button
              v-if="total > 0"
              type="button"
              data-testid="bulk-reprocess"
              :disabled="reprocessFailed.isPending.value"
              class="h-9 rounded-[9px] border border-red-300 bg-surface px-3 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              @click="onBulkReprocess"
            >
              <template v-if="reprocessFailed.isPending.value">Wird gestartet…</template>
              <template v-else-if="bulkConfirm">Wirklich {{ total }} Dokument(e) neu verarbeiten?</template>
              <template v-else>Alle fehlerhaften erneut verarbeiten ({{ total }})</template>
            </button>
            <p v-if="bulkResult" data-testid="bulk-result" class="text-xs text-red-800">{{ bulkResult }}</p>
          </div>

          <div
            v-if="spacesVisible && (selected.size > 0 || moveResult)"
            data-testid="move-bar"
            class="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-2.5 text-xs text-canvas"
          >
            <span v-if="selected.size > 0">{{ selected.size }} ausgewählt</span>
            <template v-if="selected.size > 0">
              <select
                v-model="moveTarget"
                data-testid="move-target"
                class="h-8 rounded-md bg-surface px-2 text-ink"
              >
                <option :value="null" disabled>Verschieben nach…</option>
                <option v-for="s in moveTargets" :key="s.id" :value="s.id">{{ spaceLabel(s) }}</option>
              </select>
              <button
                type="button"
                data-testid="move-submit"
                :disabled="moveTarget === null || bulkMove.isPending.value"
                class="h-8 rounded-md bg-surface px-3 font-semibold text-ink disabled:opacity-50"
                @click="onBulkMove"
              >
                {{ bulkMove.isPending.value ? "Verschiebe…" : "Verschieben" }}
              </button>
            </template>
            <span v-if="moveResult" data-testid="move-result">{{ moveResult }}</span>
          </div>

          <p v-if="errorText" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {{ errorText }}
          </p>
          <p v-else-if="library.isPending.value" class="py-12 text-center text-sm text-ink-subtle">Lade Dokumente…</p>
          <p
            v-else-if="rows.length === 0"
            class="py-14 text-center font-serif text-xl text-ink-subtle"
          >
            Keine Dokumente gefunden.
          </p>
          <template v-else>
            <label
              v-if="spacesVisible"
              class="mb-2 inline-flex items-center gap-2 px-2 text-xs text-ink-subtle"
            >
              <input
                type="checkbox"
                data-testid="select-all"
                :checked="allSelected"
                @change="toggleAll"
              >
              Alle auf dieser Seite auswählen
            </label>

            <div v-for="g in groups" :key="g.key" class="mb-7" data-testid="library-group">
              <div v-if="g.label" class="flex items-baseline gap-3 border-b border-hairline px-1 pb-2.5">
                <h2 class="font-serif text-xl font-medium text-ink">{{ g.label }}</h2>
                <span class="text-xs text-ink-subtle">{{ g.rows.length }} {{ g.rows.length === 1 ? "Dokument" : "Dokumente" }}</span>
              </div>
              <ul class="divide-y divide-hairline-soft" :class="g.label ? '' : 'border-t border-hairline'">
                <li
                  v-for="row in g.rows"
                  :key="row.id"
                  data-testid="library-row"
                  class="group relative flex cursor-pointer items-center gap-3 rounded-[10px] transition-colors hover:bg-surface/70"
                  @click.capture="onRowClick($event, row.id)"
                  @dblclick="onRowDoubleClick($event, row.id)"
                  :class="wide && previewId === row.id ? 'bg-surface' : ''"
                  :style="wide && previewId === row.id ? { boxShadow: `inset 3px 0 0 ${docTypeStyle(row.document_type).family.fill}` } : {}"
                >
                  <input
                    v-if="spacesVisible"
                    type="checkbox"
                    class="ml-2 flex-none"
                    :aria-label="`${row.title} auswählen`"
                    :data-testid="`select-${row.id}`"
                    :checked="selected.has(row.id)"
                    @change="toggleRow(row.id)"
                  >
                  <NuxtLink
                    :to="`/library/${row.id}`"
                    class="flex min-w-0 flex-1 items-center gap-4 px-2 py-2.5"
                  >
                    <DocTypeTile :type="row.document_type" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-medium text-ink" data-testid="row-title">{{ row.title }}</span>
                      <span class="mt-0.5 block truncate text-xs text-ink-subtle">
                        <span class="font-medium" :style="{ color: docTypeStyle(row.document_type).family.ink }">{{ docTypeStyle(row.document_type).name }}</span>
                        <template v-if="row.correspondent"> · {{ row.correspondent }}</template>
                        <template v-if="spacesVisible && row.shared_by">
                          · <span class="text-sky-800" data-testid="row-shared-by">{{ sharedByLabel(row.shared_by) }}</span>
                        </template>
                        <template v-else-if="spacesVisible && row.home_space">
                          · <span data-testid="row-space">{{ spaceLabel(row.home_space) }}</span>
                        </template>
                      </span>
                    </span>
                    <span class="hidden w-[92px] flex-none items-center justify-end gap-1 sm:flex">
                      <span v-if="tagSummary(row.tags).star" title="wichtig" class="text-[13px] text-[#9a6408]">★<span class="sr-only"> wichtig</span></span>
                      <span
                        v-if="tagSummary(row.tags).others.length > 0"
                        :title="tagSummary(row.tags).others.join(', ')"
                        data-testid="row-tags-more"
                        class="rounded-full border border-hairline px-[7px] py-px text-[11px] text-ink-muted"
                      >+{{ tagSummary(row.tags).others.length }}</span>
                    </span>
                    <span class="tabular hidden w-[78px] flex-none text-right text-xs text-ink-subtle md:block">
                      {{ formatDocDate(row.created) }}
                    </span>
                    <span class="flex w-[104px] flex-none justify-end">
                      <span
                        v-if="rowStatus(row.lifecycle_tags, row.ai_error_message, row.is_processing)"
                        data-testid="row-status"
                        :title="rowStatus(row.lifecycle_tags, row.ai_error_message, row.is_processing)?.title"
                        class="inline-flex items-center gap-1.5 text-xs font-medium"
                        :style="{ color: STATUS_TONE[rowStatus(row.lifecycle_tags, row.ai_error_message, row.is_processing)!.tone] }"
                      >
                        <span
                          class="h-[7px] w-[7px] rounded-full"
                          :class="row.is_processing ? 'animate-pulse' : ''"
                          :style="{ backgroundColor: STATUS_TONE[rowStatus(row.lifecycle_tags, row.ai_error_message, row.is_processing)!.tone] }"
                        />
                        {{ rowStatus(row.lifecycle_tags, row.ai_error_message, row.is_processing)?.label }}
                      </span>
                    </span>
                  </NuxtLink>
                </li>
              </ul>
            </div>

            <div v-if="pages > 1" class="mt-2 flex items-center justify-between gap-3">
              <button
                type="button"
                :disabled="filters.page <= 1"
                class="h-10 rounded-[10px] border border-hairline bg-surface px-4 text-sm font-medium text-ink disabled:opacity-40"
                @click="goToPage(filters.page - 1)"
              >
                Zurück
              </button>
              <span class="text-xs text-ink-subtle">Seite {{ filters.page }} von {{ pages }}</span>
              <button
                type="button"
                :disabled="filters.page >= pages"
                data-testid="next-page"
                class="h-10 rounded-[10px] border border-hairline bg-surface px-4 text-sm font-medium text-ink disabled:opacity-40"
                @click="goToPage(filters.page + 1)"
              >
                Weiter
              </button>
            </div>
          </template>
        </section>

        <aside
          v-if="wide && previewRow"
          data-testid="library-preview"
          class="sticky top-6 w-full max-w-[420px] flex-[1_1_340px] overflow-hidden rounded-2xl border border-hairline bg-surface"
          aria-label="Vorschau"
        >
          <div class="h-1.5" :style="{ backgroundColor: docTypeStyle(previewRow.document_type).family.fill }" />
          <div class="p-6">
            <div class="flex items-center gap-3">
              <DocTypeTile :type="previewRow.document_type" size="lg" />
              <div>
                <p
                  class="text-xs font-semibold uppercase tracking-[0.06em]"
                  :style="{ color: docTypeStyle(previewRow.document_type).family.ink }"
                >
                  {{ docTypeStyle(previewRow.document_type).name }}
                </p>
                <p class="mt-0.5 text-xs text-ink-subtle">{{ docTypeStyle(previewRow.document_type).family.name }}</p>
              </div>
            </div>
            <h3 class="mt-4 font-serif text-[26px] font-medium leading-[1.15] tracking-[-0.01em] text-ink">
              {{ previewRow.title }}
            </h3>
            <p class="mt-1.5 text-sm text-ink-muted">
              {{ previewRow.correspondent ?? "Unbekannter Absender" }} · {{ formatDocDate(previewRow.created) }}
            </p>
            <p v-if="preview.isPending.value" class="mt-5 text-xs text-ink-subtle">Lade Details…</p>
            <template v-else-if="preview.data.value && preview.data.value.id === previewRow.id">
              <p
                v-if="preview.data.value.ai_summary_de"
                class="mt-4 line-clamp-4 text-sm leading-relaxed text-ink-muted"
              >
                {{ preview.data.value.ai_summary_de }}
              </p>
              <dl v-if="previewFields.length" class="mt-5 grid grid-cols-2 gap-x-4 gap-y-3.5">
                <div v-for="f in previewFields" :key="f.k">
                  <dt class="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">{{ f.k }}</dt>
                  <dd class="tabular mt-0.5 truncate font-medium text-ink">{{ f.v }}</dd>
                </div>
              </dl>
            </template>
            <div v-if="tagSummary(previewRow.tags).star || tagSummary(previewRow.tags).others.length" class="mt-5 flex flex-wrap gap-1.5">
              <span v-if="tagSummary(previewRow.tags).star" class="rounded-full bg-[#f4e8cc] px-2.5 py-0.5 text-xs text-[#6b4504]">★ wichtig</span>
              <span
                v-for="t in tagSummary(previewRow.tags).others"
                :key="t"
                class="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs text-ink-muted"
              >{{ t }}</span>
            </div>
            <div class="mt-6 flex gap-2">
              <NuxtLink
                :to="`/library/${previewRow.id}`"
                data-testid="preview-open"
                class="flex h-11 flex-1 items-center justify-center rounded-[11px] bg-ink font-medium text-canvas hover:bg-ink-muted"
              >
                Öffnen
              </NuxtLink>
              <a
                :href="`/api/documents/${previewRow.id}/download`"
                class="flex h-11 items-center rounded-[11px] border border-hairline px-4 font-medium text-ink hover:border-ink-faint"
              >
                Herunterladen
              </a>
            </div>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>
