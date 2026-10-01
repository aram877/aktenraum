<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const tagger = useLLMSettings();
const answer = useAnswerLLMSettings();
const models = useAvailableModels();
const updateTagger = useUpdateLLMSettings();
const updateAnswer = useUpdateAnswerLLMSettings();

const pendingTagger = ref<string | null>(null);
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
  <div class="flex min-h-full flex-col">
    <div class="flex-1 px-6 py-10">
      <div class="mx-auto flex max-w-2xl flex-col gap-10">
        <h1 class="text-lg font-semibold tracking-tight text-ink">Einstellungen</h1>

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

        <SettingsAutoApprove />

        <SettingsKonto />
      </div>
    </div>
  </div>
</template>
