<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const route = useRoute();
const id = computed(() => {
  const parsed = Number.parseInt(firstParam(route.params.id), 10);
  return Number.isFinite(parsed) ? parsed : null;
});

const detail = useInboxDetail(id);
const list = useInboxList({ pageSize: 50 });
const approve = useApprove(id);
const reject = useReject(id);

const mobilePane = ref<"pdf" | "form">("form");
const { form, patch } = useHydratedForm(detail.data);

const anyPending = computed(() => approve.isPending.value || reject.isPending.value);
const errorText = computed(() => {
  if (approve.isError.value) return detailFrom(approve.error.value, "Genehmigen fehlgeschlagen.");
  if (reject.isError.value) return detailFrom(reject.error.value, "Ablehnen fehlgeschlagen.");
  return null;
});

function backToList(): void {
  void navigateTo({ path: "/library", query: { tab: "review" } });
}

function advance(direction: "next" | "prev"): void {
  if (id.value === null) return;
  const ids = list.data.value?.results.map((r) => r.id) ?? [];
  const target = pickNeighbour(ids, id.value, direction);
  if (target === undefined) {
    backToList();
    return;
  }
  void navigateTo(`/inbox/${target}`);
}

async function onApprove(): Promise<void> {
  if (!detail.data.value || anyPending.value) return;
  try {
    await approve.mutateAsync(Object.keys(patch.value).length > 0 ? patch.value : undefined);
    advance("next");
  } catch {
    return;
  }
}

async function onReject(): Promise<void> {
  if (anyPending.value) return;
  try {
    await reject.mutateAsync();
    advance("next");
  } catch {
    return;
  }
}

useShortcuts(
  () => ({
    a: () => void onApprove(),
    r: () => void onReject(),
    j: () => advance("next"),
    k: () => advance("prev"),
    Escape: backToList,
  }),
  () => detail.isSuccess.value,
);
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="border-b border-hairline bg-surface px-4 py-2 sm:px-6">
      <div class="mx-auto flex max-w-7xl items-center gap-3">
        <button
          type="button"
          class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
          @click="backToList"
        >
          ← Zur Liste
        </button>
        <span class="truncate text-sm font-medium text-ink">{{ detail.data.value?.title ?? "…" }}</span>
        <span class="ml-auto hidden text-[11px] text-ink-subtle md:inline">
          <kbd>a</kbd> genehmigen · <kbd>r</kbd> ablehnen · <kbd>j</kbd>/<kbd>k</kbd> blättern · <kbd>Esc</kbd> zurück
        </span>
      </div>
    </div>

    <PaneToggle v-model="mobilePane" />

    <p v-if="errorText" class="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ errorText }}
    </p>

    <p v-if="detail.isPending.value" class="px-6 py-8 text-sm text-ink-subtle">Lade Dokument…</p>
    <p v-else-if="detail.isError.value" class="px-6 py-8 text-sm text-red-700">Dokument konnte nicht geladen werden.</p>
    <div v-else-if="detail.data.value" class="mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4 lg:grid-cols-2 lg:p-6">
      <section
        class="min-h-[60vh] rounded-lg border border-hairline bg-surface lg:block"
        :class="{ hidden: mobilePane !== 'pdf' }"
      >
        <iframe
          v-if="id !== null"
          :src="`/api/documents/${id}/preview`"
          class="h-full min-h-[60vh] w-full rounded-lg"
          title="PDF-Vorschau"
        />
      </section>

      <section class="flex flex-col gap-3 lg:block" :class="{ hidden: mobilePane !== 'form' }">
        <DocumentFieldsForm
          v-model="form"
          :confidence="detail.data.value.ai_confidence"
          :confidence-reason="detail.data.value.ai_confidence_reason"
        />

        <div class="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            :disabled="anyPending"
            data-testid="approve"
            class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-surface disabled:opacity-50"
            @click="onApprove"
          >
            {{ approve.isPending.value ? "genehmige…" : "Genehmigen" }}
          </button>
          <button
            type="button"
            :disabled="anyPending"
            data-testid="reject"
            class="rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-50"
            @click="onReject"
          >
            {{ reject.isPending.value ? "lehne ab…" : "Ablehnen" }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
