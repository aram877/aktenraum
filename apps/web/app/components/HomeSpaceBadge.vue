<script setup lang="ts">
import type { HomeSpaceSummary, SharedBy } from "~/utils/review-form";

/**
 * Which space ("Akte") a document lives in and whose it is (ADR-009).
 * `null` = no home space yet — the worker assigns one before extraction.
 */
const props = defineProps<{ space: HomeSpaceSummary | null; sharedBy?: SharedBy | null }>();

const label = computed(() => {
  if (props.sharedBy) return sharedByLabel(props.sharedBy);
  const space = props.space;
  if (space === null) return "Keiner Akte zugeordnet";
  return space.owner ? `${space.name} · ${space.owner}` : space.name;
});

const title = computed(() => {
  if (props.sharedBy) {
    return props.sharedBy.role === "editor"
      ? "Mit dir geteilt – du darfst die Felder bearbeiten."
      : "Mit dir geteilt – nur ansehen.";
  }
  const space = props.space;
  if (space === null) return "Dieses Dokument hat noch keine Akte.";
  const kind = space.kind === "personal" ? "Persönliche Akte" : "Gemeinsame Akte";
  return space.owner ? `${kind} von ${space.owner}` : kind;
});
</script>

<template>
  <span
    data-testid="home-space"
    :title="title"
    class="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-full border px-2.5 py-1 text-xs font-medium"
    :class="sharedBy ? 'border-sky-200 bg-sky-50 text-sky-800' : space === null ? 'border-dashed border-hairline text-ink-subtle' : 'border-hairline bg-canvas text-ink'"
  >
    <span aria-hidden="true">{{ sharedBy ? "🔗" : "📁" }}</span>
    <span class="truncate">{{ label }}</span>
  </span>
</template>
