<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 400;

const route = useRoute();

const filters = computed(() => {
  const q = route.query;
  const page = Number.parseInt(firstParam(q.page) || "1", 10);
  return {
    document_type: firstParam(q.document_type),
    correspondent: firstParam(q.correspondent),
    date_from: firstParam(q.date_from),
    date_to: firstParam(q.date_to),
    text: firstParam(q.text),
    ordering: firstParam(q.ordering) || DEFAULT_ORDERING,
    tags: allParams(q.tags),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
});

const tab = computed(() => (firstParam(route.query.tab) === "review" ? "review" : "archive"));

const query = computed<LibraryQuery>(() => ({
  document_type: filters.value.document_type || null,
  correspondent: filters.value.correspondent || null,
  date_from: filters.value.date_from || null,
  date_to: filters.value.date_to || null,
  text: filters.value.text || null,
  tags: filters.value.tags.length > 0 ? filters.value.tags : null,
  ordering: filters.value.ordering,
  page: filters.value.page,
  page_size: PAGE_SIZE,
}));

const library = useLibrary(query);
const facet = useTagFacet();

const text = ref("");
const correspondent = ref("");
const filtersOpen = ref(false);
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
});

const rows = computed<readonly LibraryItem[]>(() => library.data.value?.results ?? []);
const total = computed(() => library.data.value?.total ?? 0);
const pages = computed(() => totalPages(total.value, PAGE_SIZE));
const errorText = computed(() =>
  library.isError.value ? detailFrom(library.error.value, "Laden fehlgeschlagen.") : null,
);
const hasActiveFilters = computed(() => {
  const f = filters.value;
  return Boolean(f.document_type || f.correspondent || f.date_from || f.date_to || f.text) || f.tags.length > 0;
});

function userTags(item: LibraryItem): string[] {
  return sortTagsImportantFirst(userFacingTags(item.tags));
}

function syncUrl(patch: Record<string, unknown>): void {
  void navigateTo({ path: "/library", query: cleanLibraryQuery({ ...filters.value, ...patch }) });
}

function onFilterChange(patch: Record<string, unknown>): void {
  syncUrl({ ...patch, page: 1 });
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
  void navigateTo({ path: "/library", query: {} });
}

function goToPage(next: number): void {
  if (next < 1 || next > pages.value) return;
  syncUrl({ page: next });
}

function valueOf(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value;
}
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="flex-1 px-4 py-8 sm:px-6">
      <div class="mx-auto max-w-6xl">
        <div class="flex items-center gap-2 border-b border-hairline">
          <button
            v-for="t in (['archive', 'review'] as const)"
            :key="t"
            type="button"
            :data-testid="`tab-${t}`"
            class="-mb-px border-b-2 px-3 py-2 text-sm font-medium"
            :class="tab === t ? 'border-ink text-ink' : 'border-transparent text-ink-muted'"
            @click="switchTab(t)"
          >
            {{ t === "archive" ? "Archiv" : "Zur Prüfung" }}
          </button>
        </div>

        <LibraryReviewTab v-if="tab === 'review'" />
        <template v-else>
          <div class="mt-4 flex items-baseline justify-between gap-4">
            <h1 class="text-lg font-semibold tracking-tight text-ink">Bibliothek</h1>
            <p class="text-xs text-ink-subtle" data-testid="library-total">{{ total }} Dokument(e)</p>
          </div>

          <button
            type="button"
            class="mt-4 w-full rounded-lg border border-hairline px-3 py-2 text-xs font-medium text-ink md:hidden"
            @click="filtersOpen = !filtersOpen"
          >
            Filter &amp; Tags {{ filtersOpen ? "ausblenden" : "anzeigen" }}
          </button>

          <div class="mt-4 grid gap-6 md:grid-cols-[16rem_1fr]">
            <aside class="flex-col gap-4 md:flex" :class="filtersOpen ? 'flex' : 'hidden'">
              <label class="block text-xs font-medium text-ink-muted">
                Suche
                <input
                  v-model="text"
                  type="search"
                  name="text"
                  placeholder="Volltext…"
                  class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                  @input="onTextInput"
                >
              </label>

              <label class="block text-xs font-medium text-ink-muted">
                Dokumenttyp
                <select
                  name="document_type"
                  :value="filters.document_type"
                  class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
                  @change="onFilterChange({ document_type: valueOf($event) })"
                >
                  <option value="">Alle</option>
                  <option v-for="dt in DOC_TYPES" :key="dt" :value="dt">{{ dt }}</option>
                </select>
              </label>

              <label class="block text-xs font-medium text-ink-muted">
                Korrespondent
                <input
                  v-model="correspondent"
                  type="text"
                  name="correspondent"
                  class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
                  @blur="onFilterChange({ correspondent })"
                >
              </label>

              <div class="grid grid-cols-2 gap-2">
                <label class="block text-xs font-medium text-ink-muted">
                  Von
                  <input
                    type="date"
                    name="date_from"
                    :value="filters.date_from"
                    class="mt-1 w-full rounded-lg border border-hairline bg-surface px-2 py-2 text-sm text-ink"
                    @change="onFilterChange({ date_from: valueOf($event) })"
                  >
                </label>
                <label class="block text-xs font-medium text-ink-muted">
                  Bis
                  <input
                    type="date"
                    name="date_to"
                    :value="filters.date_to"
                    class="mt-1 w-full rounded-lg border border-hairline bg-surface px-2 py-2 text-sm text-ink"
                    @change="onFilterChange({ date_to: valueOf($event) })"
                  >
                </label>
              </div>

              <label class="block text-xs font-medium text-ink-muted">
                Sortierung
                <select
                  name="ordering"
                  :value="filters.ordering"
                  class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
                  @change="onFilterChange({ ordering: valueOf($event) })"
                >
                  <option v-for="opt in ORDERING_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
              </label>

              <div v-if="facet.data.value?.results?.length">
                <p class="text-xs font-medium text-ink-muted">Tags</p>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <button
                    v-for="tag in facet.data.value.results"
                    :key="tag.name"
                    type="button"
                    class="rounded-full border px-2.5 py-1 text-[11px] font-medium"
                    :class="filters.tags.includes(tag.name) ? 'border-accent text-accent' : 'border-hairline text-ink-muted'"
                    @click="toggleTag(tag.name)"
                  >
                    {{ tag.name }} ({{ tag.count }})
                  </button>
                </div>
              </div>

              <button
                v-if="hasActiveFilters"
                type="button"
                class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
                @click="clearFilters"
              >
                Filter zurücksetzen
              </button>
            </aside>

            <section>
              <p v-if="errorText" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {{ errorText }}
              </p>
              <p v-else-if="library.isPending.value" class="text-xs text-ink-subtle">Lade Dokumente…</p>
              <p
                v-else-if="rows.length === 0"
                class="rounded-lg border border-hairline bg-surface px-4 py-8 text-center text-sm text-ink-muted"
              >
                Keine Dokumente gefunden.
              </p>
              <template v-else>
                <div class="hidden overflow-x-auto rounded-lg border border-hairline md:block">
                  <table class="w-full text-sm">
                    <thead class="bg-canvas text-left text-xs text-ink-muted">
                      <tr>
                        <th class="px-3 py-2 font-medium">Titel</th>
                        <th class="px-3 py-2 font-medium">Typ</th>
                        <th class="px-3 py-2 font-medium">Korrespondent</th>
                        <th class="px-3 py-2 font-medium">Datum</th>
                        <th class="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in rows" :key="row.id" class="border-t border-hairline hover:bg-canvas/50">
                        <td class="px-3 py-2">
                          <NuxtLink :to="`/library/${row.id}`" class="text-ink hover:text-accent">{{ row.title }}</NuxtLink>
                          <div v-if="userTags(row).length" class="mt-1 flex flex-wrap gap-1">
                            <span
                              v-for="tag in userTags(row)"
                              :key="tag"
                              class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                              :class="tag === 'wichtig' ? 'bg-amber-100 text-amber-800' : 'bg-surface-raised text-ink-muted'"
                            >
                              {{ tag === "wichtig" ? "★ wichtig" : tag }}
                            </span>
                          </div>
                        </td>
                        <td class="px-3 py-2 text-ink-muted">{{ row.document_type ?? "—" }}</td>
                        <td class="px-3 py-2 text-ink-muted">{{ row.correspondent ?? "—" }}</td>
                        <td class="px-3 py-2 text-ink-muted">{{ row.created ?? "—" }}</td>
                        <td class="px-3 py-2">
                          <ProcessingBadge
                            :tags="row.lifecycle_tags"
                            :error-message="row.ai_error_message"
                            :in-flight="row.is_processing"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <ul class="flex flex-col gap-2 md:hidden">
                  <li v-for="row in rows" :key="row.id" class="rounded-lg border border-hairline bg-surface p-3">
                    <NuxtLink :to="`/library/${row.id}`" class="text-sm font-medium text-ink">{{ row.title }}</NuxtLink>
                    <p class="mt-1 text-xs text-ink-muted">{{ row.document_type ?? "—" }} · {{ row.correspondent ?? "—" }}</p>
                    <p class="mt-0.5 text-xs text-ink-subtle">{{ row.created ?? "—" }}</p>
                    <div class="mt-2">
                      <ProcessingBadge
                        :tags="row.lifecycle_tags"
                        :error-message="row.ai_error_message"
                        :in-flight="row.is_processing"
                      />
                    </div>
                  </li>
                </ul>

                <div v-if="pages > 1" class="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    :disabled="filters.page <= 1"
                    class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
                    @click="goToPage(filters.page - 1)"
                  >
                    Zurück
                  </button>
                  <span class="text-xs text-ink-subtle">Seite {{ filters.page }} von {{ pages }}</span>
                  <button
                    type="button"
                    :disabled="filters.page >= pages"
                    data-testid="next-page"
                    class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
                    @click="goToPage(filters.page + 1)"
                  >
                    Weiter
                  </button>
                </div>
              </template>
            </section>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
