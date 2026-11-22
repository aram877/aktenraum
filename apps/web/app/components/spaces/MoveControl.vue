<script setup lang="ts">
import type { HomeSpaceSummary } from "~/utils/review-form";

/**
 * "Verschieben" for one document: only for the owner of its current space,
 * into a space where the member is owner or editor (ADR-009).
 */
const props = defineProps<{ docId: number; space: HomeSpaceSummary | null | undefined }>();

const { spaces, visible } = useSpacesVisible();
const move = useMoveDocument();

const ownsCurrent = computed(() => {
  const current = props.space;
  if (!current) return false;
  return spaces.data.value?.spaces.some((s) => s.id === current.id && s.role === "owner") ?? false;
});
const targets = computed(() => placeableSpaces(spaces.data.value).filter((s) => s.id !== props.space?.id));

const open = ref(false);
const target = ref<number | null>(null);
const error = ref<string | null>(null);

async function onMove(): Promise<void> {
  const spaceId = target.value;
  if (spaceId === null) return;
  error.value = null;
  try {
    await move.mutateAsync({ docId: props.docId, spaceId });
    open.value = false;
    target.value = null;
  } catch (e: unknown) {
    error.value = detailFrom(e, "Verschieben fehlgeschlagen.");
  }
}
</script>

<template>
  <div v-if="visible && ownsCurrent && targets.length > 0" class="relative" data-testid="move-control">
    <button
      type="button"
      data-testid="move-open"
      class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
      @click="open = !open"
    >
      Verschieben
    </button>
    <div
      v-if="open"
      class="absolute right-0 z-20 mt-1 flex w-64 flex-col gap-2 rounded-lg border border-hairline bg-surface p-3 shadow-lg"
    >
      <select
        v-model="target"
        data-testid="move-select"
        class="rounded border border-hairline bg-surface px-2 py-1.5 text-xs"
      >
        <option :value="null" disabled>In Akte…</option>
        <option v-for="s in targets" :key="s.id" :value="s.id">{{ spaceLabel(s) }}</option>
      </select>
      <button
        type="button"
        data-testid="move-confirm"
        :disabled="target === null || move.isPending.value"
        class="btn btn-primary btn-sm"
        @click="onMove"
      >
        {{ move.isPending.value ? "Verschiebe…" : "Verschieben" }}
      </button>
      <p v-if="error" class="text-xs text-red-600" data-testid="move-error">{{ error }}</p>
    </div>
  </div>
</template>
