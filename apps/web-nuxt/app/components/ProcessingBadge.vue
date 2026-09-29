<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    tags?: readonly string[];
    errorMessage?: string | null;
    inFlight?: boolean;
  }>(),
  { tags: () => [], errorMessage: null, inFlight: false },
);

const state = computed(() => classify(props.tags, props.errorMessage));
const hasDuplicate = computed(() => props.tags.includes("ai-duplicate"));
const hasEmail = computed(() => props.tags.includes("email-ingested"));
</script>

<template>
  <span
    v-if="inFlight"
    title="Wird gerade vom Auto-Tagger bearbeitet."
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
    :class="VARIANT_STYLE.info"
  >
    <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
    <span>Wird verarbeitet…</span>
  </span>
  <span v-else class="inline-flex items-center gap-1">
    <span
      :title="state.title"
      class="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
      :class="VARIANT_STYLE[state.variant]"
      data-testid="badge-label"
    >
      {{ state.label }}
    </span>
    <span
      v-if="hasEmail"
      title="Per E-Mail eingegangen."
      class="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700"
    >
      E-Mail
    </span>
    <span
      v-if="hasDuplicate"
      title="Mögliches Duplikat erkannt — bitte im Vorschau-Fenster prüfen."
      class="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
    >
      Duplikat?
    </span>
  </span>
</template>
