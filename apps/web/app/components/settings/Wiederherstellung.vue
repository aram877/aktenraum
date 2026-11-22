<script setup lang="ts">
/** Recovery codes: how many are left; a new set (shown once) invalidates the old one. */
const status = useRecoveryStatus();
const regenerate = useRegenerateRecoveryCodes();
const me = useMe();
const fresh = ref<string[] | null>(null);

const remaining = computed(() => status.data.value?.remaining ?? null);
const error = computed(() =>
  regenerate.isError.value ? passkeyErrorMessage(regenerate.error.value, "Neue Codes konnten nicht erstellt werden.") : null,
);

async function onRegenerate(): Promise<void> {
  try {
    fresh.value = (await regenerate.mutateAsync()).codes;
  } catch {
    return;
  }
}
</script>

<template>
  <div>
    <h3 class="font-serif text-lg font-medium text-ink">Wiederherstellungscodes</h3>
    <RecoveryCodes
      v-if="fresh"
      class="mt-3"
      :codes="fresh"
      :username="me.data.value?.username"
      continue-label="Fertig"
      @continue="fresh = null"
    />
    <template v-else>
      <p class="mt-2 text-sm text-ink" data-testid="recovery-remaining">
        <template v-if="remaining === null">…</template>
        <template v-else>{{ remaining }} von 10 Codes unbenutzt.</template>
      </p>
      <p v-if="remaining !== null && remaining <= 3" class="mt-1 text-xs text-amber-800">
        Nur noch wenige Codes — erstelle einen neuen Satz.
      </p>
      <button
        type="button"
        data-testid="recovery-regenerate"
        :disabled="regenerate.isPending.value"
        class="mt-3 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-60"
        @click="onRegenerate"
      >
        Neue Codes erstellen
      </button>
      <p class="mt-1 text-[11px] text-ink-faint">Alle bisherigen Codes werden dabei ungültig.</p>
      <p v-if="error" class="mt-2 text-xs text-red-600" data-testid="recovery-error">{{ error }}</p>
    </template>
  </div>
</template>
