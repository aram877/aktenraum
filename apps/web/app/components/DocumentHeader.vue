<script setup lang="ts">
// Detail page header (ui-redesign-foundation): a band tinted in the document
// type's area colour with the 72 px tile, a serif title and one meta line.
// Slots: `back` (link or button above the band), `actions` (right of the title).
const props = defineProps<{
  type: string | null | undefined;
  title: string;
  correspondent?: string | null;
  date?: string | null;
}>();

const style = computed(() => docTypeStyle(props.type));
const meta = computed(() =>
  [props.correspondent, props.date ? formatDocDate(props.date) : null].filter((part): part is string => Boolean(part)),
);
</script>

<template>
  <header>
    <div class="border-b border-hairline">
      <div class="mx-auto flex h-12 max-w-[1360px] items-center gap-3 px-4 sm:px-8">
        <slot name="back" />
        <slot name="hint" />
      </div>
    </div>
    <div
      data-testid="document-header"
      :data-family="style.family.key"
      class="border-b"
      :style="{ backgroundColor: style.family.tint, borderColor: style.family.tint }"
    >
      <div class="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-6 gap-y-4 px-4 py-6 sm:px-8 sm:py-8">
        <DocTypeTile :type="type" size="xl" class="hidden sm:inline-flex" />
        <DocTypeTile :type="type" size="lg" class="sm:hidden" />
        <div class="min-w-0 flex-[1_1_380px]">
          <p class="text-xs font-semibold uppercase tracking-[0.08em]" :style="{ color: style.family.ink }">
            {{ style.name }} · {{ style.family.name }}
          </p>
          <h1
            class="mt-1.5 font-serif text-3xl font-medium leading-[1.1] tracking-[-0.02em] text-ink sm:text-[40px]"
            data-testid="document-title"
          >
            {{ title }}
          </h1>
          <p v-if="meta.length" class="mt-2 text-sm text-ink-muted">{{ meta.join(" · ") }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </header>
</template>
