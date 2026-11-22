<script setup lang="ts">
const route = useRoute();
</script>

<template>
  <div class="flex min-h-full items-center justify-center px-4 py-16">
    <div class="card w-full max-w-md p-8 text-center">
      <AppLogo :size="52" class="mb-5" />
      <p class="text-xs font-semibold uppercase tracking-[0.08em] text-accent">Seite nicht gefunden</p>
      <h1 class="mt-2 break-all font-serif text-2xl font-medium text-ink" data-testid="not-found-path">
        {{ route.fullPath }}
      </h1>
      <p class="mt-3 text-sm text-ink-muted">Diese Adresse gibt es in aktenraum nicht.</p>
      <NuxtLink
        to="/"
        class="btn btn-primary mt-6"
      >
        Zurück zur Startseite
      </NuxtLink>
    </div>
  </div>
</template>
