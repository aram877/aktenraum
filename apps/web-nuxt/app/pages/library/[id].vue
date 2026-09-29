<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const route = useRoute();
const id = computed(() => {
  const parsed = Number.parseInt(firstParam(route.params.id), 10);
  return Number.isFinite(parsed) ? parsed : null;
});

const detail = useDocumentDetail(id);
const fieldsPatch = useDocumentFieldsPatch(id);
const reprocess = useReprocess();

const mobilePane = ref<"pdf" | "form">("form");
const savedAt = ref<number | null>(null);
const confirmingReprocess = ref(false);

const { form, patch, dirty, reset } = useHydratedForm(detail.data, () => {
  confirmingReprocess.value = false;
});

const errorText = computed(() => {
  if (fieldsPatch.isError.value) return detailFrom(fieldsPatch.error.value, "Speichern fehlgeschlagen.");
  if (reprocess.isError.value) return detailFrom(reprocess.error.value, "Erneut verarbeiten fehlgeschlagen.");
  return null;
});

async function onSave(): Promise<void> {
  if (!dirty.value) return;
  try {
    await fieldsPatch.mutateAsync(patch.value);
    savedAt.value = Date.now();
    setTimeout(() => {
      savedAt.value = null;
    }, 3000);
  } catch {
    return;
  }
}

async function onReprocess(): Promise<void> {
  if (id.value === null) return;
  if (!confirmingReprocess.value) {
    confirmingReprocess.value = true;
    return;
  }
  try {
    await reprocess.mutateAsync(id.value);
    confirmingReprocess.value = false;
    await navigateTo("/library");
  } catch {
    confirmingReprocess.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="border-b border-hairline bg-surface px-4 py-2 sm:px-6">
      <div class="mx-auto flex max-w-7xl items-center gap-3">
        <NuxtLink
          to="/library"
          class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
        >
          ← Bibliothek
        </NuxtLink>
        <span class="truncate text-sm font-medium text-ink">{{ detail.data.value?.title ?? "…" }}</span>
        <a
          :href="`/api/documents/${id}/download`"
          class="ml-auto rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
        >
          Herunterladen
        </a>
      </div>
    </div>

    <PaneToggle v-model="mobilePane" />

    <p v-if="errorText" class="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ errorText }}
    </p>
    <p
      v-if="savedAt"
      data-testid="saved"
      class="mx-4 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
    >
      Gespeichert.
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
            :disabled="!dirty || fieldsPatch.isPending.value"
            data-testid="save"
            class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-surface disabled:opacity-50"
            @click="onSave"
          >
            {{ fieldsPatch.isPending.value ? "speichere…" : "Speichern" }}
          </button>
          <button
            type="button"
            :disabled="!dirty || fieldsPatch.isPending.value"
            data-testid="reset"
            class="rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-50"
            @click="reset"
          >
            Zurücksetzen
          </button>
          <button
            type="button"
            :disabled="reprocess.isPending.value"
            data-testid="reprocess"
            class="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
            :class="confirmingReprocess ? 'border-amber-400 text-amber-800' : 'border-hairline text-ink'"
            @click="onReprocess"
          >
            {{ reprocess.isPending.value ? "starte…" : confirmingReprocess ? "Wirklich? Erneut klicken" : "Erneut verarbeiten" }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
