<script setup lang="ts">
// Two different chat models can't stay loaded on one GPU: Ollama swaps them on every question
// and every upload, which is what made Ask take 20-60 s (fast-ask).
const props = defineProps<{ taggerModel: string | null; answerModel: string | null }>();

const differs = computed(
  () =>
    !!props.taggerModel && !!props.answerModel && props.taggerModel !== props.answerModel,
);
</script>

<template>
  <p
    v-if="differs"
    data-testid="model-mismatch-hint"
    class="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
  >
    Klassifizierung und Antworten nutzen verschiedene Modelle. Beide passen meist nicht gleichzeitig in den
    Grafikspeicher — Ollama lädt sie bei jeder Frage und jedem Upload neu, und Ask wird deutlich langsamer.
    Mit demselben Modell für beides bleibt es geladen.
  </p>
</template>
