<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{ error: NuxtError }>();

const unreachable = computed(() => {
  const status = props.error.statusCode;
  return !status || status >= 500;
});

function home(): void {
  void clearError({ redirect: "/" });
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-canvas px-4 py-16 text-ink">
    <div class="w-full max-w-md rounded-xl border border-hairline bg-surface p-8 text-center">
      <p class="text-xs font-medium uppercase tracking-wide text-ink-subtle" data-testid="error-status">
        Fehler {{ error.statusCode ?? "" }}
      </p>
      <h1 class="mt-2 text-lg font-semibold tracking-tight text-ink">
        {{ unreachable ? "Server nicht erreichbar." : "Etwas ist schiefgelaufen." }}
      </h1>
      <p class="mt-3 text-sm text-ink-muted">
        {{ unreachable ? "Die aktenraum-API antwortet gerade nicht. Bitte gleich noch einmal versuchen." : error.statusMessage || error.message }}
      </p>
      <button
        type="button"
        class="mt-6 inline-block rounded-lg bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80"
        @click="home"
      >
        Zurück zur Startseite
      </button>
    </div>
  </div>
</template>
