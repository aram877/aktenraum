<script setup lang="ts">
definePageMeta({ middleware: "auth" });

// Household settings and member management are the household admin's;
// a plain member manages only their own account here.
const isAdmin = useIsHouseholdAdmin();

const tagger = useLLMSettings();
const answer = useAnswerLLMSettings();
const models = useAvailableModels();
const updateTagger = useUpdateLLMSettings();
const updateAnswer = useUpdateAnswerLLMSettings();

const pendingTagger = ref<string | null>(null);

const sections = computed(() => [
  ...(isAdmin.value
    ? [
        { id: "modelle", label: "KI-Modelle" },
        { id: "auto-genehmigung", label: "Auto-Genehmigung" },
        { id: "backup", label: "Backup" },
        { id: "mitglieder", label: "Mitglieder" },
      ]
    : []),
  { id: "konto", label: "Konto" },
]);
const pendingAnswer = ref<string | null>(null);

async function onPickTagger(model: string): Promise<void> {
  pendingTagger.value = model;
  try {
    await updateTagger.mutateAsync(model);
  } finally {
    pendingTagger.value = null;
  }
}

async function onPickAnswer(model: string): Promise<void> {
  pendingAnswer.value = model;
  try {
    await updateAnswer.mutateAsync(model);
  } finally {
    pendingAnswer.value = null;
  }
}
</script>

<template>
  <div class="page">
    <PageHeader eyebrow="System" title="Einstellungen" />

    <div class="mt-8 flex flex-wrap items-start gap-8">
      <nav
        class="sticky top-6 hidden w-52 flex-none flex-col gap-0.5 text-sm lg:flex"
        aria-label="Abschnitte"
        data-testid="settings-index"
      >
        <a
          v-for="s in sections"
          :key="s.id"
          :href="`#${s.id}`"
          class="rounded-[9px] px-3 py-2 text-ink-muted hover:bg-surface-raised hover:text-ink"
        >
          {{ s.label }}
        </a>
      </nav>

      <div class="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <template v-if="isAdmin">
          <section id="modelle" class="card scroll-mt-6 p-6 sm:p-8">
            <SettingsModelPicker
              title="Modell für Klassifizierung"
              description="Wird für die Extraktion der ai_* Felder beim Hochladen verwendet."
              field-name="tagger-model"
              :active-model="tagger.data.value?.model ?? null"
              :available-models="models.data.value ?? []"
              :is-models-loading="models.isPending.value"
              :is-pending="updateTagger.isPending.value"
              :pending="pendingTagger"
              @pick="onPickTagger"
            />
            <SettingsModelPicker
              class="mt-8 border-t border-hairline pt-8"
              title="Modell für Antworten"
              description="Wird für die Prosa-Antworten auf der Ask-Seite verwendet."
              field-name="answer-model"
              :active-model="answer.data.value?.model ?? null"
              :available-models="models.data.value ?? []"
              :is-models-loading="models.isPending.value"
              :is-pending="updateAnswer.isPending.value"
              :pending="pendingAnswer"
              @pick="onPickAnswer"
            />
            <SettingsModelMismatchHint
              :tagger-model="tagger.data.value?.model ?? null"
              :answer-model="answer.data.value?.model ?? null"
            />
          </section>

          <section id="auto-genehmigung" class="card scroll-mt-6 p-6 sm:p-8">
            <SettingsAutoApprove />
          </section>

          <section class="card scroll-mt-6 p-6 sm:p-8">
            <SettingsBackup />
          </section>

          <section id="mitglieder" class="card scroll-mt-6 p-6 sm:p-8">
            <SettingsMitglieder />
          </section>
        </template>

        <section class="card scroll-mt-6 p-6 sm:p-8">
          <SettingsKonto id="konto" />
        </section>
      </div>
    </div>
  </div>
</template>
