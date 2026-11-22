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
const deleteDoc = useDeleteDocument();

const mobilePane = ref<"pdf" | "form">("form");
const savedAt = ref<number | null>(null);
const confirmingReprocess = ref(false);
const confirmingDelete = ref(false);

const { form, patch, dirty, reset } = useHydratedForm(detail.data, () => {
  confirmingReprocess.value = false;
  confirmingDelete.value = false;
});

const starred = computed(() => hasTag(detail.data.value?.tags, "wichtig"));
// Shared with me: no state changes; a viewer share also can't edit fields.
const access = computed(() => detail.data.value?.access);
const mayChangeState = computed(() => canChangeState(access.value));
const mayEditFields = computed(() => canEditFields(access.value));
const { visible: spacesVisible } = useSpacesVisible();
const ownsHomeSpace = computed(
  () => access.value?.via === "space" && access.value.role === "owner" && Boolean(detail.data.value?.home_space),
);
const duplicate = computed(() => hasTag(detail.data.value?.tags, "ai-duplicate"));

const errorText = computed(() => {
  if (fieldsPatch.isError.value) return detailFrom(fieldsPatch.error.value, "Speichern fehlgeschlagen.");
  if (reprocess.isError.value) return detailFrom(reprocess.error.value, "Erneut verarbeiten fehlgeschlagen.");
  if (deleteDoc.isError.value) return detailFrom(deleteDoc.error.value, "Löschen fehlgeschlagen.");
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

async function onDelete(): Promise<void> {
  if (id.value === null) return;
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  try {
    await deleteDoc.mutateAsync(id.value);
    await navigateTo("/library");
  } catch {
    confirmingDelete.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-full flex-col">
    <DocumentHeader
      :type="detail.data.value?.ai_document_type"
      :title="detail.data.value?.title ?? '…'"
      :correspondent="detail.data.value?.ai_correspondent"
      :date="detail.data.value?.ai_issue_date ?? detail.data.value?.created"
    >
      <template #back>
        <NuxtLink
          to="/library"
          class="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-muted hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          Bibliothek
        </NuxtLink>
      </template>
      <template #actions>
        <HomeSpaceBadge
          v-if="detail.data.value && detail.data.value.home_space !== undefined"
          :space="detail.data.value.home_space"
          :shared-by="detail.data.value.shared_by"
          class="hidden sm:inline-flex"
        />
        <SpacesMoveControl
          v-if="id !== null && detail.data.value && mayChangeState"
          :doc-id="id"
          :space="detail.data.value.home_space"
        />
        <StarToggle v-if="id !== null && detail.data.value && mayChangeState" :doc-id="id" :starred="starred" />
        <a
          v-if="id !== null"
          :href="`/api/documents/${id}/download`"
          class="inline-flex h-10 items-center rounded-[10px] border border-black/10 bg-surface px-4 text-sm font-medium text-ink hover:border-black/20"
        >
          Herunterladen
        </a>
      </template>
    </DocumentHeader>

    <PaneToggle v-model="mobilePane" />

    <p v-if="errorText" role="alert" class="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
    <div v-else-if="detail.data.value" class="mx-auto grid w-full max-w-[1360px] flex-1 gap-6 p-4 lg:grid-cols-2 lg:p-8">
      <section
        class="min-h-[60vh] overflow-hidden rounded-2xl bg-surface-sunken p-2 lg:block"
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
        <DuplicatePanel v-if="duplicate && id !== null && mayChangeState" :doc-id="id" class="mb-3" />
        <DocumentFieldsForm
          v-model="form"
          :confidence="detail.data.value.ai_confidence"
          :confidence-reason="detail.data.value.ai_confidence_reason"
          :readonly="!mayEditFields"
        />

        <div class="mt-2 flex flex-wrap gap-2">
          <button
            v-if="mayEditFields"
            type="button"
            :disabled="!dirty || fieldsPatch.isPending.value"
            data-testid="save"
            class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-surface disabled:opacity-50"
            @click="onSave"
          >
            {{ fieldsPatch.isPending.value ? "speichere…" : "Speichern" }}
          </button>
          <button
            v-if="mayEditFields"
            type="button"
            :disabled="!dirty || fieldsPatch.isPending.value"
            data-testid="reset"
            class="rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-50"
            @click="reset"
          >
            Zurücksetzen
          </button>
          <button
            v-if="mayChangeState"
            type="button"
            :disabled="reprocess.isPending.value"
            data-testid="reprocess"
            class="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
            :class="confirmingReprocess ? 'border-amber-400 text-amber-800' : 'border-hairline text-ink'"
            @click="onReprocess"
          >
            {{ reprocess.isPending.value ? "starte…" : confirmingReprocess ? "Wirklich? Erneut klicken" : "Erneut verarbeiten" }}
          </button>
          <button
            v-if="mayChangeState"
            type="button"
            :disabled="deleteDoc.isPending.value"
            data-testid="delete"
            class="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
            :class="confirmingDelete ? 'border-red-400 bg-red-50 text-red-700' : 'border-hairline text-red-700 hover:bg-red-50'"
            @click="onDelete"
          >
            {{ deleteDoc.isPending.value ? "lösche…" : confirmingDelete ? "In den Papierkorb? Erneut klicken" : "Löschen" }}
          </button>
        </div>

        <TypeFieldsSection
          v-if="id !== null"
          :doc-id="id"
          :document-type="detail.data.value.ai_document_type"
          :values="detail.data.value.type_fields"
          :readonly="!mayEditFields"
        />

        <SharesSharePanel
          v-if="id !== null && spacesVisible && ownsHomeSpace && detail.data.value.home_space"
          :doc-id="id"
          :space-id="detail.data.value.home_space.id"
        />
      </section>
    </div>
  </div>
</template>
