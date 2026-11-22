<script setup lang="ts">
// Shared page header (ui-redesign-pages): accent eyebrow, serif title, muted
// subtitle; `actions` sits on the right (wraps under on narrow screens), the
// default slot goes under the subtitle.
defineProps<{ eyebrow?: string; title: string; subtitle?: string }>();
</script>

<template>
  <header class="flex flex-wrap items-end gap-x-8 gap-y-4" data-testid="page-header">
    <div class="min-w-0">
      <p v-if="eyebrow" class="text-xs font-semibold uppercase tracking-[0.08em] text-accent">{{ eyebrow }}</p>
      <h1 class="mt-1.5 font-serif text-4xl font-medium leading-none tracking-[-0.02em] text-ink sm:text-5xl">
        {{ title }}
      </h1>
      <p v-if="subtitle" class="mt-2 max-w-2xl text-sm text-ink-subtle">{{ subtitle }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="ml-auto flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
