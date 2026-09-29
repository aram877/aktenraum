<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title: string;
    description: string;
    fieldName: string;
    activeModel?: string | null;
    availableModels?: readonly string[];
    isModelsLoading?: boolean;
    isPending?: boolean;
    pending?: string | null;
  }>(),
  {
    activeModel: null,
    availableModels: () => [],
    isModelsLoading: false,
    isPending: false,
    pending: null,
  },
);

const emit = defineEmits<{ pick: [model: string] }>();

const manualValue = ref("");
watch(
  () => props.activeModel,
  (value) => {
    manualValue.value = value ?? "";
  },
  { immediate: true },
);

const hasLiveList = computed(() => props.availableModels.length > 0);

const options = computed<readonly string[]>(() => {
  const active = props.activeModel;
  const list = props.availableModels;
  if (hasLiveList.value && active && !list.includes(active)) return [active, ...list];
  return list;
});

const hint = computed(() => {
  if (props.pending) return "speichere…";
  if (props.isModelsLoading) return "Lade verfügbare Modelle…";
  if (!hasLiveList.value) {
    return "Kein Ollama erreichbar (oder Backend ist Anthropic) — Modell manuell eingeben.";
  }
  return `aktiv: ${props.activeModel}`;
});

function onSelect(event: Event): void {
  emit("pick", (event.target as HTMLSelectElement).value);
}

function onManualSubmit(): void {
  const trimmed = manualValue.value.trim();
  if (trimmed) emit("pick", trimmed);
}
</script>

<template>
  <div>
    <h2 class="text-sm font-semibold text-ink">{{ title }}</h2>
    <p class="mt-0.5 text-xs text-ink-muted">{{ description }}</p>
    <div class="mt-3">
      <select
        v-if="hasLiveList"
        :name="fieldName"
        :value="activeModel ?? ''"
        :disabled="isPending"
        class="w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
        @change="onSelect"
      >
        <option v-for="m in options" :key="m" :value="m">{{ m }}</option>
      </select>
      <form v-else class="flex gap-2" @submit.prevent="onManualSubmit">
        <input
          v-model="manualValue"
          type="text"
          :name="fieldName"
          :disabled="isPending"
          placeholder="z.B. qwen2.5:14b-instruct-q8_0"
          class="flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
        >
        <button
          type="submit"
          :disabled="isPending || !manualValue.trim()"
          class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
        >
          Speichern
        </button>
      </form>
      <p class="mt-1.5 text-[11px] text-ink-subtle">{{ hint }}</p>
    </div>
  </div>
</template>
