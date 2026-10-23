<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const recent = useIngestActivity(1);
const live = useLiveCounts();
const errorList = useErrorCount();
const summary = computed(() => recent.data.value?.summary ?? null);
const errorCount = computed(() => live.data.value?.errors ?? errorList.data.value?.total ?? 0);

const cards = [
  {
    to: "/ask",
    eyebrow: "KI-Assistent",
    eyebrowAccent: true,
    title: "Ask AI →",
    description: "Stelle Fragen zu deinen Dokumenten in natürlicher Sprache.",
  },
  {
    to: "/scan",
    eyebrow: "Scannen",
    eyebrowAccent: false,
    title: "Dokument scannen →",
    description: "Mit der Kamera erfassen — direkt als PDF ablegen.",
  },
  {
    to: "/library",
    eyebrow: "Archiv",
    eyebrowAccent: false,
    title: "Bibliothek →",
    description: "Alle klassifizierten Dokumente durchsuchen.",
  },
  {
    to: "/upload",
    eyebrow: "Eingang",
    eyebrowAccent: false,
    title: "+ Hochladen",
    description: "PDF oder Bild hochladen — KI klassifiziert automatisch.",
  },
] as const;
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="flex-1 px-6 py-12">
      <div class="mx-auto max-w-2xl">
        <h1 class="text-2xl font-semibold tracking-tight text-ink">Willkommen im aktenraum.</h1>
        <p class="mt-2 text-sm text-ink-muted">
          Dein KI-gestütztes Dokumentenarchiv. Hochladen, finden, verstehen.
        </p>

        <div
          class="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-hairline bg-surface px-4 py-3 text-xs"
          data-testid="home-activity"
        >
          <NuxtLink to="/activity" class="text-ink hover:text-accent">
            <span class="font-medium">Letzte 24 h:</span>
            <template v-if="summary">
              {{ summary.new }} neu · {{ summary.duplicate }} Duplikate · {{ summary.failed }} Importfehler
              <template v-if="summary.running > 0"> · {{ summary.running }} laufen</template>
            </template>
            <template v-else-if="recent.isError.value"> nicht verfügbar</template>
            <template v-else> …</template>
            →
          </NuxtLink>
          <NuxtLink
            v-if="errorCount > 0"
            to="/library?status=error"
            data-testid="home-errors"
            class="font-medium text-red-600 hover:text-red-700"
          >
            {{ errorCount }} Dokument(e) mit Verarbeitungsfehler →
          </NuxtLink>
        </div>

        <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NuxtLink
            v-for="card in cards"
            :key="card.to"
            :to="card.to"
            class="group flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface p-5 transition-colors hover:border-hairline-soft hover:bg-surface"
          >
            <span
              class="text-xs font-medium uppercase tracking-wide"
              :class="card.eyebrowAccent ? 'text-accent' : 'text-ink-subtle'"
            >
              {{ card.eyebrow }}
            </span>
            <span class="text-sm font-medium text-ink">{{ card.title }}</span>
            <span class="text-xs text-ink-subtle">{{ card.description }}</span>
          </NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>
