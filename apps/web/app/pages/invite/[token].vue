<script setup lang="ts">
definePageMeta({ layout: "bare", middleware: "guest" });

const route = useRoute();
const token = computed(() => String(route.params.token ?? ""));

const check = useInviteCheck(token);
const redeem = useRedeemInvite(token);

const username = ref("");
const password = ref("");
const confirm = ref("");

const tooShort = computed(() => password.value.length > 0 && password.value.length < 8);
const mismatch = computed(() => confirm.value.length > 0 && confirm.value !== password.value);
const canSubmit = computed(
  () =>
    username.value.trim().length >= 3 &&
    password.value.length >= 8 &&
    password.value === confirm.value &&
    !redeem.isPending.value,
);

const invalid = computed(() => check.isError.value && statusOf(check.error.value) === 404);
const redeemError = computed(() => {
  if (!redeem.isError.value) return null;
  const status = statusOf(redeem.error.value);
  if (status === 409) return "Dieser Benutzername ist bereits vergeben.";
  if (status === 404) return "Die Einladung ist nicht mehr gültig.";
  if (status === 429) return "Zu viele Versuche. Bitte später erneut versuchen.";
  return detailFrom(redeem.error.value, "Beitritt fehlgeschlagen.");
});

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    await redeem.mutateAsync({ username: username.value.trim(), password: password.value });
    await navigateTo("/");
  } catch {
    return;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-sm rounded-xl border border-hairline bg-surface p-8">
      <h1 class="mb-1 text-xl font-semibold tracking-tight text-ink">aktenraum</h1>

      <p v-if="check.isPending.value" class="text-sm text-ink-subtle">Einladung wird geprüft…</p>

      <div v-else-if="invalid || (check.isError.value && !invalid)" data-testid="invite-invalid">
        <p class="mt-4 text-sm text-ink">
          {{
            invalid
              ? "Diese Einladung ist ungültig, abgelaufen oder wurde schon verwendet."
              : detailFrom(check.error.value, "Einladung konnte nicht geprüft werden.")
          }}
        </p>
        <p class="mt-2 text-xs text-ink-subtle">Bitte um einen neuen Link.</p>
      </div>

      <form v-else data-testid="invite-form" @submit.prevent="onSubmit">
        <p class="mb-7 text-sm text-ink-subtle">
          Du wurdest in einen Haushalt eingeladen. Wähle Benutzername und Passwort — deine
          Dokumente bleiben privat, bis du sie teilst.
        </p>

        <label class="block text-xs font-medium text-ink-muted">
          Benutzername
          <input
            v-model="username"
            type="text"
            name="username"
            autocomplete="username"
            required
            minlength="3"
            maxlength="64"
            class="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
        </label>
        <label class="mt-4 block text-xs font-medium text-ink-muted">
          Passwort (mindestens 8 Zeichen)
          <input
            v-model="password"
            type="password"
            name="password"
            autocomplete="new-password"
            required
            class="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
        </label>
        <p v-if="tooShort" class="mt-1 text-xs text-red-600">Mindestens 8 Zeichen.</p>
        <label class="mt-4 block text-xs font-medium text-ink-muted">
          Passwort wiederholen
          <input
            v-model="confirm"
            type="password"
            name="confirm"
            autocomplete="new-password"
            required
            class="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
        </label>
        <p v-if="mismatch" class="mt-1 text-xs text-red-600">Die Passwörter stimmen nicht überein.</p>

        <p v-if="redeemError" class="mt-3 text-sm text-red-600" data-testid="redeem-error">{{ redeemError }}</p>

        <button
          type="submit"
          data-testid="redeem"
          :disabled="!canSubmit"
          class="mt-6 block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
        >
          {{ redeem.isPending.value ? "Beitreten…" : "Beitreten" }}
        </button>
      </form>
    </div>
  </div>
</template>
