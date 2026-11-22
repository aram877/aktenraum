<script setup lang="ts">
// The "Stapel" logo (chosen 2026-11-22): an indigo (Arbeit) and an ochre
// (Geld) sheet fanned out behind a white sheet with a green tab (Gesundheit)
// and text lines. Colours are `--color-logo-*` tokens (dark values in
// main.css). Geometry must match scripts/brand/make-icons.py, which renders
// the favicon / app icons — tests/unit/brand.spec.ts compares them.
// Below 24 px the lines and tab are dropped and the outline gets bolder, like
// the favicon; `wordmark` adds "aktenraum" in the serif.
const props = withDefaults(defineProps<{ size?: number; wordmark?: boolean }>(), { size: 32, wordmark: false });
const simple = computed(() => props.size < 24);
</script>

<template>
  <span class="inline-flex items-center gap-2.5" data-testid="app-logo">
    <svg
      :width="size"
      :height="size"
      viewBox="0 0 64 64"
      class="flex-none"
      :role="wordmark ? undefined : 'img'"
      :aria-label="wordmark ? undefined : 'aktenraum'"
      :aria-hidden="wordmark ? 'true' : undefined"
    >
      <rect x="20" y="7" width="32" height="42" rx="5" transform="rotate(9 36 28)" class="fill-logo-back" />
      <rect x="13" y="11" width="32" height="42" rx="5" transform="rotate(-7 29 32)" class="fill-logo-mid" />
      <rect
        x="16"
        y="14"
        width="32"
        height="42"
        rx="5"
        class="fill-logo-front stroke-logo-ink"
        :stroke-width="simple ? 4 : 2.6"
      />
      <template v-if="!simple">
        <rect x="22" y="20" width="9" height="3.4" rx="1.7" class="fill-logo-tab" />
        <path d="M22 30h20M22 37h20M22 44h12" class="stroke-logo-ink" stroke-width="2.6" stroke-linecap="round" />
      </template>
    </svg>
    <span v-if="wordmark" class="font-serif font-medium tracking-[-0.01em] text-ink">aktenraum</span>
  </span>
</template>
