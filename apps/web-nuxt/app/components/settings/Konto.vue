<script setup lang="ts">
const REDIRECT_DELAY_MS = 1500;

const change = useChangePassword();
const current = ref("");
const next = ref("");
const confirm = ref("");
const showSuccess = ref(false);

const confirmMismatch = computed(() => confirm.value.length > 0 && confirm.value !== next.value);
const newTooShort = computed(() => next.value.length > 0 && next.value.length < 8);
const canSubmit = computed(
  () =>
    current.value.length > 0 &&
    next.value.length >= 8 &&
    next.value === confirm.value &&
    !change.isPending.value &&
    !showSuccess.value,
);
const errorBanner = computed(() =>
  change.isError.value ? mapChangePasswordError(statusOf(change.error.value)) : null,
);
const locked = computed(() => change.isPending.value || showSuccess.value);

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    await change.mutateAsync({ currentPassword: current.value, newPassword: next.value });
    current.value = "";
    next.value = "";
    confirm.value = "";
    showSuccess.value = true;
    setTimeout(() => void navigateTo("/login"), REDIRECT_DELAY_MS);
  } catch {
    return;
  }
}
</script>

<template>
  <div>
    <h2 class="text-sm font-semibold text-ink">Konto</h2>
    <p class="mt-0.5 text-xs text-ink-muted">
      Passwort ändern. Du wirst nach erfolgreicher Änderung neu angemeldet.
    </p>

    <p
      v-if="showSuccess"
      data-testid="konto-success"
      class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
    >
      Passwort geändert — du wirst zum Login geleitet.
    </p>
    <p
      v-if="errorBanner && !showSuccess"
      data-testid="konto-error"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {{ errorBanner }}
    </p>

    <form class="mt-4 space-y-3" novalidate @submit.prevent="onSubmit">
      <label class="block">
        <span class="text-xs font-medium text-ink-muted">Aktuelles Passwort</span>
        <input
          v-model="current"
          type="password"
          name="current"
          autocomplete="current-password"
          :disabled="locked"
          class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
        >
      </label>

      <label class="block">
        <span class="text-xs font-medium text-ink-muted">Neues Passwort</span>
        <input
          v-model="next"
          type="password"
          name="next"
          autocomplete="new-password"
          minlength="8"
          maxlength="128"
          :disabled="locked"
          class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
        >
        <span v-if="newTooShort" class="mt-1 block text-[11px] text-red-700">Mindestens 8 Zeichen.</span>
      </label>

      <label class="block">
        <span class="text-xs font-medium text-ink-muted">Neues Passwort bestätigen</span>
        <input
          v-model="confirm"
          type="password"
          name="confirm"
          autocomplete="new-password"
          :disabled="locked"
          class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
        >
        <span v-if="confirmMismatch" class="mt-1 block text-[11px] text-red-700">
          Passwörter stimmen nicht überein.
        </span>
      </label>

      <button
        type="submit"
        :disabled="!canSubmit"
        class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ change.isPending.value ? "speichere…" : "Passwort ändern" }}
      </button>
    </form>
  </div>
</template>
