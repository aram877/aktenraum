<script setup lang="ts">
const route = useRoute();
</script>

<template>
  <div class="flex min-h-full items-center justify-center px-4 py-16">
    <div class="w-full max-w-md rounded-xl border border-hairline bg-surface p-8 text-center">
      <p class="text-xs font-medium uppercase tracking-wide text-ink-subtle">Seite nicht gefunden</p>
      <h1 class="mt-2 text-lg font-semibold tracking-tight text-ink" data-testid="not-found-path">
        {{ route.fullPath }}
      </h1>
      <p class="mt-3 text-sm text-ink-muted">Diese Adresse gibt es in aktenraum nicht.</p>
      <NuxtLink
        to="/"
        class="mt-6 inline-block rounded-lg bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80"
      >
        Zurück zur Startseite
      </NuxtLink>
    </div>
  </div>
</template>
