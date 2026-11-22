<script setup lang="ts">
definePageMeta({ middleware: "auth" });

// Home / Übersicht (ui-redesign-pages): every number here comes from queries
// the nav or the library already run, so they share the Vue Query cache.
const me = useMe();
const recent = useIngestActivity(1);
const live = useLiveCounts();
const errorList = useErrorCount();
const inbox = useInboxList({ pageSize: 1 });
const inFlight = useInFlightCount();
const typeFacet = useTypeFacet();
const newest = useLibrary(computed<LibraryQuery>(() => ({ ordering: "-created", page: 1, page_size: 6 })));

const summary = computed(() => recent.data.value?.summary ?? null);
const errorCount = computed(() => live.data.value?.errors ?? errorList.data.value?.total ?? 0);
const reviewCount = computed(() => live.data.value?.inbox ?? inbox.data.value?.total ?? 0);
const processingCount = computed(() =>
  Math.max(0, (live.data.value?.in_flight ?? inFlight.data.value?.count ?? 0) - reviewCount.value),
);
const areas = computed(() => familyCounts(typeFacet.data.value?.results ?? []).filter((a) => a.count > 0));
const newestRows = computed(() => newest.data.value?.results ?? []);

const greeting = computed(() => {
  const hour = new Date().getHours();
  const part = hour < 11 ? "Guten Morgen" : hour < 18 ? "Guten Tag" : "Guten Abend";
  const name = me.data.value?.username;
  return name ? `${part}, ${name}` : part;
});

const question = ref("");
function onAsk(): void {
  const q = question.value.trim();
  if (q) void navigateTo({ path: "/ask", query: { q } });
}

const stats = computed(() => [
  {
    key: "review",
    label: "Zur Prüfung",
    value: reviewCount.value,
    to: "/library?tab=review",
    tone: reviewCount.value > 0 ? "var(--color-tone-warning)" : null,
  },
  {
    key: "processing",
    label: "In Bearbeitung",
    value: processingCount.value,
    to: "/activity",
    tone: processingCount.value > 0 ? "var(--color-tone-info)" : null,
  },
  {
    key: "errors",
    label: "Mit Fehler",
    value: errorCount.value,
    to: "/library?status=error",
    tone: errorCount.value > 0 ? "var(--color-tone-danger)" : null,
  },
  {
    key: "new",
    label: "Neu in 24 h",
    value: summary.value?.new ?? "–",
    to: "/activity",
    tone: null,
  },
]);
</script>

<template>
  <div class="page">
    <PageHeader eyebrow="Übersicht" :title="greeting" subtitle="Dein Dokumentenarchiv auf einen Blick." />

    <form class="mt-8 flex flex-wrap gap-2" @submit.prevent="onAsk">
      <label class="flex h-12 min-w-0 flex-[1_1_320px] items-center gap-3 rounded-xl border border-hairline bg-surface px-4 text-ink-subtle focus-within:border-ink-faint">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <span class="sr-only">Frage an deine Dokumente</span>
        <input
          v-model="question"
          name="home-question"
          type="text"
          placeholder="Frag deine Dokumente – z. B. „Wann läuft mein Mietvertrag aus?“"
          class="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
        >
      </label>
      <button type="submit" class="btn btn-primary h-12 px-6" :disabled="question.trim() === ''">Fragen</button>
    </form>

    <div class="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="home-stats">
      <NuxtLink
        v-for="s in stats"
        :key="s.key"
        :to="s.to"
        :data-testid="s.key === 'errors' && errorCount > 0 ? 'home-errors' : `home-stat-${s.key}`"
        class="card group flex flex-col gap-1 p-5 transition-colors hover:border-ink-faint"
      >
        <span class="label-caps">{{ s.label }}</span>
        <span class="tabular font-serif text-4xl font-medium leading-tight" :style="s.tone ? { color: s.tone } : {}">
          {{ s.value }}
        </span>
      </NuxtLink>
    </div>

    <p class="mt-3 text-xs text-ink-subtle" data-testid="home-activity">
      <NuxtLink to="/activity" class="hover:text-ink">
        <span class="font-medium text-ink-muted">Letzte 24 h:</span>
        <template v-if="summary">
          {{ summary.new }} neu · {{ summary.duplicate }} Duplikate · {{ summary.failed }} Importfehler
          <template v-if="summary.running > 0"> · {{ summary.running }} laufen</template>
        </template>
        <template v-else-if="recent.isError.value"> nicht verfügbar</template>
        <template v-else> …</template>
        →
      </NuxtLink>
    </p>

    <div class="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <section aria-labelledby="home-newest">
        <div class="flex items-baseline justify-between gap-3 border-b border-hairline px-1 pb-2.5">
          <h2 id="home-newest" class="font-serif text-xl font-medium text-ink">Neueste Dokumente</h2>
          <NuxtLink to="/library" class="text-xs font-medium text-accent hover:text-accent-dark">Zur Bibliothek →</NuxtLink>
        </div>
        <p v-if="newest.isPending.value" class="py-8 text-center text-sm text-ink-subtle">Lade…</p>
        <p v-else-if="newestRows.length === 0" class="py-10 text-center font-serif text-lg text-ink-subtle">
          Noch keine Dokumente.
          <NuxtLink to="/upload" class="text-accent">Jetzt hochladen →</NuxtLink>
        </p>
        <ul v-else class="divide-y divide-hairline-soft" data-testid="home-newest">
          <li v-for="row in newestRows" :key="row.id">
            <NuxtLink
              :to="`/library/${row.id}`"
              class="flex items-center gap-4 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-surface/70"
            >
              <DocTypeTile :type="row.document_type" />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium text-ink">{{ row.title }}</span>
                <span class="mt-0.5 block truncate text-xs text-ink-subtle">
                  <span class="font-medium" :style="{ color: docTypeStyle(row.document_type).family.ink }">{{ docTypeStyle(row.document_type).name }}</span>
                  <template v-if="row.correspondent"> · {{ row.correspondent }}</template>
                </span>
              </span>
              <span class="tabular text-xs text-ink-subtle">{{ formatDocDate(row.created) }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <section aria-labelledby="home-areas">
        <div class="flex items-baseline justify-between gap-3 border-b border-hairline px-1 pb-2.5">
          <h2 id="home-areas" class="font-serif text-xl font-medium text-ink">Bereiche</h2>
          <NuxtLink to="/upload" class="text-xs font-medium text-accent hover:text-accent-dark">+ Hochladen</NuxtLink>
        </div>
        <ul class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2" data-testid="home-areas">
          <li v-for="a in areas" :key="a.family.key">
            <NuxtLink
              :to="`/library?family=${a.family.key}`"
              :data-testid="`home-area-${a.family.key}`"
              class="card flex items-center gap-3 px-3.5 py-3 transition-colors hover:border-ink-faint"
            >
              <span class="h-8 w-8 flex-none rounded-[9px]" :style="{ backgroundColor: a.family.fill }" />
              <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{{ a.family.name }}</span>
              <span class="tabular text-sm text-ink-subtle">{{ a.count }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
