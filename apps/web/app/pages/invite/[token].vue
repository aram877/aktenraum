<script setup lang="ts">
definePageMeta({ layout: "bare", middleware: "guest" });

/** Joining a household: a username and a passkey (auth-passkeys) — no password. */
const route = useRoute();
const token = computed(() => String(route.params.token ?? ""));

const check = useInviteCheck(token);
const redeem = useRedeemInvite(token);

const username = ref("");
const codes = ref<string[] | null>(null);
const joinedAs = ref("");

const canSubmit = computed(() => username.value.trim().length >= 3 && !redeem.isPending.value);

const invalid = computed(() => check.isError.value && statusOf(check.error.value) === 404);
const redeemError = computed(() => {
  if (!redeem.isError.value) return null;
  const status = statusOf(redeem.error.value);
  if (status === 409) return "Dieser Benutzername ist bereits vergeben.";
  if (status === 404) return "Die Einladung ist nicht mehr gültig.";
  return passkeyErrorMessage(redeem.error.value, "Beitritt fehlgeschlagen.");
});

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    const result = await redeem.mutateAsync({ username: username.value.trim() });
    joinedAs.value = result.username;
    if (result.recovery_codes && result.recovery_codes.length > 0) codes.value = result.recovery_codes;
    else await navigateTo("/");
  } catch {
    return;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-8">
      <AppLogo :size="52" class="mb-5" />
      <h1 class="mb-1 font-serif text-3xl font-medium tracking-[-0.02em] text-ink">aktenraum</h1>

      <RecoveryCodes v-if="codes" class="mt-4" :codes="codes" :username="joinedAs" @continue="navigateTo('/')" />

      <p v-else-if="check.isPending.value" class="text-sm text-ink-subtle">Einladung wird geprüft…</p>

      <div v-else-if="check.isError.value" data-testid="invite-invalid">
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
        <p class="mb-5 text-sm text-ink-subtle">
          Du wurdest in einen Haushalt eingeladen. Wähle einen Benutzernamen und lege einen Passkey
          an (Windows Hello, Handy oder Passwortmanager) — ein Passwort gibt es nicht. Deine
          Dokumente bleiben privat, bis du sie teilst.
        </p>
        <PasskeyAddressHint class="mb-4" />

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

        <p v-if="redeemError" class="mt-3 text-sm text-red-600" data-testid="redeem-error">{{ redeemError }}</p>

        <button
          type="submit"
          data-testid="redeem"
          :disabled="!canSubmit"
          class="mt-6 block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
        >
          {{ redeem.isPending.value ? "Warte auf Passkey…" : "Passkey erstellen und beitreten" }}
        </button>
      </form>
    </div>
  </div>
</template>
