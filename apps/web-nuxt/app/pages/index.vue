<script setup lang="ts">
definePageMeta({ middleware: "auth" });

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

        <div class="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
