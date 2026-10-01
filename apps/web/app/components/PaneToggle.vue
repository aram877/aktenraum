<script setup lang="ts">
const pane = defineModel<"pdf" | "form">({ required: true });
</script>

<template>
  <div class="border-b border-hairline bg-surface px-4 py-2 lg:hidden">
    <div class="flex gap-2">
      <button
        v-for="option in (['pdf', 'form'] as const)"
        :key="option"
        type="button"
        :data-testid="`pane-${option}`"
        class="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium"
        :class="pane === option ? 'border-ink' : 'border-hairline'"
        @click="pane = option"
      >
        {{ option === "pdf" ? "PDF" : "Bearbeiten" }}
      </button>
    </div>
  </div>
</template>
