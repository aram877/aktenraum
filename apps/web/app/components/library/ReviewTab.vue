<script setup lang="ts">
const list = useInboxListInfinite({ pageSize: 50, ordering: "-modified" });
const bulkApprove = useBulkApprove();

const selected = ref<ReadonlySet<number>>(new Set());
const lastResult = ref<{ succeeded: number; failed: number } | null>(null);

const rows = computed<readonly InboxItem[]>(
  () => list.data.value?.pages.flatMap((p) => p.results) ?? [],
);
const total = computed(() => list.data.value?.pages[0]?.total ?? 0);
const loaded = computed(() => rows.value.length);
const visibleIds = computed(() => rows.value.map((r) => r.id));
const effectiveSelected = computed(() => pruneSelection(selected.value, visibleIds.value));
const selectedCount = computed(() => effectiveSelected.value.size);
const allSelected = computed(
  () => visibleIds.value.length > 0 && visibleIds.value.every((id) => effectiveSelected.value.has(id)),
);

function toggleOne(id: number): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(visibleIds.value);
}

function clearSelection(): void {
  selected.value = new Set();
}

async function onBulkApprove(): Promise<void> {
  const ids = [...effectiveSelected.value];
  if (ids.length === 0) return;
  lastResult.value = null;
  const result = await bulkApprove.mutateAsync(ids);
  lastResult.value = { succeeded: result.succeeded.length, failed: result.failed.length };
  const next = new Set(selected.value);
  for (const id of result.succeeded) next.delete(id);
  selected.value = next;
}

function loadMore(): void {
  void list.fetchNextPage();
}
</script>

<template>
  <div class="mt-8 w-full">
    <div class="flex items-baseline justify-between gap-3 border-b border-hairline px-1 pb-2.5">
      <div class="min-w-0">
        <h2 class="font-serif text-xl font-medium text-ink">Zur Prüfung</h2>
        <p class="mt-0.5 text-xs text-ink-subtle">
          Die KI hat diese Dokumente eingeordnet – bitte kurz prüfen.
        </p>
      </div>
      <span class="shrink-0 text-sm text-ink-subtle" data-testid="review-total">
        {{ list.data.value ? `${total} offen` : "…" }}
      </span>
    </div>

    <p v-if="list.isError.value" class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      Konnte die Liste nicht laden.
    </p>

    <div
      v-if="list.data.value && loaded === 0"
      class="mt-8 rounded-lg border border-dashed border-hairline bg-surface p-8 text-center text-sm text-ink-subtle"
    >
      Keine offenen Dokumente.
      <NuxtLink to="/ask" class="font-medium text-ink underline">Suche stattdessen.</NuxtLink>
    </div>

    <template v-if="list.data.value && loaded > 0">
      <div
        v-if="selectedCount > 0"
        class="sticky top-0 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-inverse/20 bg-inverse px-4 py-2 text-sm text-on-inverse"
        data-testid="bulk-bar"
      >
        <span>{{ selectedCount }} {{ selectedCount === 1 ? "Dokument ausgewählt" : "Dokumente ausgewählt" }}</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            :disabled="bulkApprove.isPending.value"
            class="rounded-md border border-white/20 px-3 py-1 text-xs text-on-inverse/80 hover:bg-white/10 disabled:opacity-60"
            @click="clearSelection"
          >
            Auswahl aufheben
          </button>
          <button
            type="button"
            :disabled="bulkApprove.isPending.value"
            data-testid="bulk-approve"
            class="rounded-md bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-60"
            @click="onBulkApprove"
          >
            {{ bulkApprove.isPending.value ? "Genehmige…" : `${selectedCount} genehmigen` }}
          </button>
        </div>
      </div>

      <p
        v-if="lastResult"
        class="mt-3 rounded-lg border px-3 py-2 text-sm"
        data-testid="bulk-result"
        :class="lastResult.failed > 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'"
      >
        {{ lastResult.succeeded }} genehmigt{{ lastResult.failed ? ` · ${lastResult.failed} fehlgeschlagen` : "" }}.
      </p>

      <label class="mt-4 inline-flex items-center gap-2 px-2 text-xs text-ink-subtle">
        <input
          type="checkbox"
          aria-label="Alle auswählen"
          data-testid="select-all"
          :checked="allSelected"
          class="h-4 w-4 cursor-pointer accent-ink"
          @change="toggleAll"
        >
        Alle geladenen auswählen
      </label>

      <ul class="mt-1 divide-y divide-hairline-soft">
        <li
          v-for="row in rows"
          :key="row.id"
          data-testid="review-row"
          class="flex items-center gap-3 rounded-[10px] transition-colors hover:bg-surface/70"
        >
          <input
            type="checkbox"
            :aria-label="`${row.title} auswählen`"
            :checked="effectiveSelected.has(row.id)"
            class="ml-2 h-4 w-4 flex-none cursor-pointer accent-ink"
            @change="toggleOne(row.id)"
          >
          <NuxtLink :to="`/inbox/${row.id}`" class="flex min-w-0 flex-1 items-center gap-4 px-2 py-2.5">
            <DocTypeTile :type="row.ai_document_type" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium text-ink">{{ row.ai_title || row.title }}</span>
              <span class="mt-0.5 block truncate text-xs text-ink-subtle">
                <span class="font-medium" :style="{ color: docTypeStyle(row.ai_document_type).family.ink }">
                  {{ docTypeStyle(row.ai_document_type).name }}
                </span>
                <template v-if="row.ai_correspondent"> · {{ row.ai_correspondent }}</template>
              </span>
            </span>
            <span class="tabular hidden w-[78px] flex-none text-right text-xs text-ink-subtle sm:block">
              {{ formatDocDate(row.ai_issue_date ?? row.created) }}
            </span>
            <span
              class="tabular w-[72px] flex-none text-right text-xs font-medium"
              :class="row.low_confidence ? 'text-[#a14b06]' : 'text-ink-muted'"
              :title="row.low_confidence ? 'Die KI ist sich unsicher.' : 'KI-Sicherheit'"
            >
              <span v-if="row.low_confidence" class="mr-1 inline-block h-[7px] w-[7px] rounded-full bg-[#a14b06]" />
              {{ formatConfidence(row.ai_confidence) }}
            </span>
          </NuxtLink>
        </li>
      </ul>

      <div v-if="list.hasNextPage.value || list.isFetchingNextPage.value" class="mt-4 flex items-center justify-center gap-3">
        <span class="text-xs text-ink-subtle">{{ loaded }} von {{ total }} geladen</span>
        <button
          type="button"
          :disabled="list.isFetchingNextPage.value || !list.hasNextPage.value"
          data-testid="load-more"
          class="rounded-md border border-hairline bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
          @click="loadMore"
        >
          {{ list.isFetchingNextPage.value ? "lade…" : "Mehr anzeigen" }}
        </button>
      </div>
    </template>
  </div>
</template>
