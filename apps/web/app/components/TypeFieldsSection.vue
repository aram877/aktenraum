<script setup lang="ts">
const props = defineProps<{
  docId: number;
  documentType: string | null;
  values: Record<string, string> | null;
}>();

const schema = useTypeFieldSchema();
const save = useTypeFieldsPatch(() => props.docId);

const defs = computed(() =>
  props.documentType ? (schema.data.value?.[props.documentType] ?? []) : [],
);
const draft = ref<Record<string, string>>({});
const savedAt = ref(false);

watch(
  [defs, () => props.values, () => props.docId],
  () => {
    draft.value = typeFieldsDraft(defs.value, props.values);
  },
  { immediate: true },
);

const changes = computed(() => typeFieldsChanges(draft.value, props.values));
const dirty = computed(() => Object.keys(changes.value).length > 0);

function setField(name: string, event: Event): void {
  draft.value = { ...draft.value, [name]: (event.target as HTMLInputElement).value };
  savedAt.value = false;
}

async function onSave(): Promise<void> {
  if (!dirty.value || !props.documentType) return;
  try {
    await save.mutateAsync({ document_type: props.documentType, fields: changes.value });
    savedAt.value = true;
  } catch {
    savedAt.value = false;
  }
}
</script>

<template>
  <section v-if="defs.length > 0" data-testid="type-fields" class="mt-4 rounded-lg border border-hairline bg-surface p-3">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-ink-muted">{{ documentType }}-Felder</h2>
    <div class="mt-2 grid gap-2 sm:grid-cols-2">
      <label v-for="def in defs" :key="def.name" class="block text-xs font-medium text-ink-muted">
        {{ def.label_de }}
        <input
          type="text"
          :name="`type-field-${def.name}`"
          :placeholder="FIELD_TYPE_PLACEHOLDER[def.field_type]"
          :value="draft[def.name]"
          class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          @input="setField(def.name, $event)"
        >
      </label>
    </div>
    <p v-if="save.isError.value" role="alert" class="mt-2 text-xs text-red-700">
      {{ detailFrom(save.error.value, "Felder konnten nicht gespeichert werden.") }}
    </p>
    <div class="mt-2 flex items-center gap-2">
      <button
        type="button"
        data-testid="save-type-fields"
        :disabled="!dirty || save.isPending.value"
        class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50"
        @click="onSave"
      >
        {{ save.isPending.value ? "speichere…" : "Felder speichern" }}
      </button>
      <span v-if="savedAt && !dirty" data-testid="type-fields-saved" class="text-xs text-emerald-700">Gespeichert.</span>
    </div>
  </section>
</template>
