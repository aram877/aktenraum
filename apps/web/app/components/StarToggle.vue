<script setup lang="ts">
const props = defineProps<{ docId: number; starred: boolean }>();

const toggle = useToggleStar(() => props.docId);
</script>

<template>
  <button
    type="button"
    data-testid="star"
    :aria-pressed="starred"
    :disabled="toggle.isPending.value"
    :title="starred ? 'Markierung „wichtig“ entfernen' : 'Als wichtig markieren'"
    class="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
    :class="starred ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-hairline text-ink hover:bg-canvas'"
    @click="toggle.mutate(!starred)"
  >
    {{ starred ? "★ Wichtig" : "☆ Als wichtig markieren" }}
  </button>
</template>
