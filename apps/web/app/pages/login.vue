<script setup lang="ts">
definePageMeta({ layout: "bare", middleware: "guest" });

/**
 * Sign-in (auth-passkeys): a passkey first. A password only works until the
 * member has created a passkey and leads straight to enrolment; a recovery
 * code does the same for a member who lost their passkeys.
 */
type Mode = "passkey" | "password" | "recovery";
const mode = ref<Mode>("passkey");

const passkey = usePasskeyLogin();
const login = useLogin();
const recovery = useRecoveryLogin();

const username = ref("");
const password = ref("");
const code = ref("");

const passkeyError = computed(() =>
  passkey.isError.value ? passkeyErrorMessage(passkey.error.value, "Anmeldung mit Passkey fehlgeschlagen.") : null,
);
const recoveryError = computed(() => {
  if (!recovery.isError.value) return null;
  const status = statusOf(recovery.error.value);
  if (status === 429) return "Zu viele Versuche. Bitte später erneut versuchen.";
  return "Benutzername oder Wiederherstellungscode falsch.";
});

async function onPasskey(): Promise<void> {
  try {
    const user = await passkey.mutateAsync();
    await navigateTo(user?.enrolment_required ? "/enrol" : "/");
  } catch {
    return;
  }
}

async function onPassword(): Promise<void> {
  try {
    await login.mutateAsync({ username: username.value, password: password.value });
    await navigateTo("/enrol");
  } catch {
    return;
  }
}

async function onRecovery(): Promise<void> {
  try {
    await recovery.mutateAsync({ username: username.value.trim(), code: code.value });
    await navigateTo("/enrol");
  } catch {
    return;
  }
}

const inputClass =
  "mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";
const primaryClass =
  "mt-6 block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60";
const linkClass = "text-xs text-ink-muted underline hover:text-ink";
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-8">
      <AppLogo :size="52" class="mb-5" />
      <h1 class="mb-1 font-serif text-3xl font-medium tracking-[-0.02em] text-ink">aktenraum</h1>
      <p class="mb-5 text-sm text-ink-subtle">Melde dich an, um fortzufahren.</p>

      <PasskeyAddressHint class="mb-4" />

      <template v-if="mode === 'passkey'">
        <button
          type="button"
          data-testid="passkey-login"
          :disabled="passkey.isPending.value"
          :class="primaryClass"
          class="!mt-0"
          @click="onPasskey"
        >
          {{ passkey.isPending.value ? "Warte auf Passkey…" : "Mit Passkey anmelden" }}
        </button>
        <p v-if="passkeyError" class="mt-3 text-sm text-red-600" data-testid="passkey-error">{{ passkeyError }}</p>
        <div class="mt-6 flex flex-col items-start gap-2 border-t border-hairline pt-4">
          <button type="button" data-testid="mode-recovery" :class="linkClass" @click="mode = 'recovery'">
            Wiederherstellungscode verwenden
          </button>
          <button type="button" data-testid="mode-password" :class="linkClass" @click="mode = 'password'">
            Erstmalig mit Passwort anmelden
          </button>
        </div>
      </template>

      <form v-else-if="mode === 'password'" data-testid="password-form" @submit.prevent="onPassword">
        <p class="mb-4 text-xs text-ink-muted">
          Nur bis du einen Passkey angelegt hast — direkt danach wirst du darum gebeten, und das
          Passwort funktioniert nicht mehr.
        </p>
        <label class="block text-xs font-medium text-ink-muted">
          Benutzername
          <input v-model="username" type="text" name="username" autocomplete="username" required :class="inputClass">
        </label>
        <label class="mt-4 block text-xs font-medium text-ink-muted">
          Passwort
          <input v-model="password" type="password" name="password" autocomplete="current-password" required :class="inputClass">
        </label>
        <p v-if="login.isError.value" class="mt-3 text-sm text-red-600" data-testid="login-error">
          {{ statusOf(login.error.value) === 429 ? "Zu viele Versuche. Bitte später erneut versuchen." : "Ungültige Anmeldedaten. Bitte erneut versuchen." }}
        </p>
        <button type="submit" :disabled="login.isPending.value" :class="primaryClass">
          {{ login.isPending.value ? "Anmelden…" : "Anmelden" }}
        </button>
        <button type="button" class="mt-4" :class="linkClass" @click="mode = 'passkey'">Zurück zur Passkey-Anmeldung</button>
      </form>

      <form v-else data-testid="recovery-form" @submit.prevent="onRecovery">
        <p class="mb-4 text-xs text-ink-muted">
          Kein Passkey mehr? Mit einem deiner Wiederherstellungscodes meldest du dich an und legst
          sofort einen neuen Passkey an. Der Code ist danach verbraucht.
        </p>
        <label class="block text-xs font-medium text-ink-muted">
          Benutzername
          <input v-model="username" type="text" name="username" autocomplete="username" required :class="inputClass">
        </label>
        <label class="mt-4 block text-xs font-medium text-ink-muted">
          Wiederherstellungscode
          <input
            v-model="code"
            type="text"
            name="code"
            autocomplete="one-time-code"
            placeholder="XXXX-XXXX-XXXX-XXXX"
            required
            :class="inputClass"
            class="font-mono"
          >
        </label>
        <p v-if="recoveryError" class="mt-3 text-sm text-red-600" data-testid="recovery-error">{{ recoveryError }}</p>
        <button type="submit" :disabled="recovery.isPending.value" :class="primaryClass">
          {{ recovery.isPending.value ? "Prüfe…" : "Anmelden und Passkey anlegen" }}
        </button>
        <button type="button" class="mt-4" :class="linkClass" @click="mode = 'passkey'">Zurück zur Passkey-Anmeldung</button>
      </form>
    </div>
  </div>
</template>
