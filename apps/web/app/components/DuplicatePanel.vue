<script setup lang="ts">
const props = defineProps<{ docId: number }>();

const candidates = useDuplicateCandidates(() => props.docId, true);
const dismiss = useDismissDuplicate(() => props.docId);
</script>

<template>
  <section
    data-testid="duplicate-panel"
    role="status"
    class="rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm text-purple-900"
  >
    <p class="font-medium">Mögliches Duplikat</p>
    <p v-if="candidates.isPending.value" class="mt-1 text-xs">Suche passende Dokumente…</p>
    <ul v-else-if="(candidates.data.value?.candidates.length ?? 0) > 0" class="mt-1 space-y-0.5 text-xs">
      <li v-for="c in candidates.data.value?.candidates" :key="c.id">
        <NuxtLink :to="`/library/${c.id}`" class="underline hover:no-underline">
          Mögliches Duplikat von #{{ c.id }} – {{ c.title }}
        </NuxtLink>
      </li>
    </ul>
    <p v-else class="mt-1 text-xs">Das passende Dokument wurde nicht mehr gefunden.</p>
    <p v-if="dismiss.isError.value" role="alert" class="mt-1 text-xs text-red-700">
      {{ detailFrom(dismiss.error.value, "Markierung konnte nicht entfernt werden.") }}
    </p>
    <button
      type="button"
      data-testid="dismiss-duplicate"
      :disabled="dismiss.isPending.value"
      class="mt-2 rounded-lg border border-purple-300 bg-surface px-3 py-1.5 text-xs font-medium text-purple-900 disabled:opacity-50"
      @click="dismiss.mutate()"
    >
      {{ dismiss.isPending.value ? "entferne…" : "Kein Duplikat" }}
    </button>
  </section>
</template>
