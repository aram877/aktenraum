<script setup lang="ts">
defineProps<{
  docs: readonly DocumentSummary[];
  /** `data-testid` of every row. */
  itemTestId: string;
}>();
</script>

<template>
  <ul class="divide-y divide-hairline-soft">
    <li v-for="doc in docs" :key="doc.id" :data-testid="itemTestId">
      <NuxtLink
        :to="`/library/${doc.id}`"
        class="flex items-center gap-4 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-surface/70"
      >
        <DocTypeTile :type="doc.document_type" />
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-ink">{{ doc.title }}</span>
          <span class="mt-0.5 block truncate text-xs text-ink-subtle">
            <span class="font-medium" :style="{ color: docTypeStyle(doc.document_type).family.ink }">{{ docTypeStyle(doc.document_type).name }}</span>
            <template v-if="doc.correspondent"> · {{ doc.correspondent }}</template>
          </span>
        </span>
        <span class="tabular text-xs text-ink-subtle">{{ formatDocDate(doc.created) }}</span>
      </NuxtLink>
    </li>
  </ul>
</template>
