<script setup lang="ts">
definePageMeta({ layout: "bare", middleware: "auth" });

/**
 * First passkey after a password or recovery-code sign-in (auth-passkeys):
 * create it, keep the recovery codes, continue. Until then every other page
 * answers 403 `enrolment_required` and the router lands here.
 */
const me = useMe();
const register = useRegisterPasskey();
const logout = useLogout();
const codes = ref<string[] | null>(null);

const error = computed(() =>
  register.isError.value ? passkeyErrorMessage(register.error.value, "Passkey konnte nicht angelegt werden.") : null,
);

async function onCreate(): Promise<void> {
  try {
    const result = await register.mutateAsync({});
    if (result.recovery_codes && result.recovery_codes.length > 0) codes.value = result.recovery_codes;
    else await navigateTo("/");
  } catch {
    return;
  }
}

async function onLogout(): Promise<void> {
  await logout.mutateAsync().catch(() => undefined);
  await navigateTo("/login");
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-md rounded-xl border border-hairline bg-surface p-8">
      <h1 class="mb-1 text-xl font-semibold tracking-tight text-ink">Passkey anlegen</h1>

      <RecoveryCodes
        v-if="codes"
        class="mt-4"
        :codes="codes"
        :username="me.data.value?.username"
        @continue="navigateTo('/')"
      />

      <template v-else>
        <p class="mb-5 text-sm text-ink-subtle">
          aktenraum meldet dich ab jetzt mit einem Passkey an — Windows Hello, dein Handy oder dein
          Passwortmanager bestätigen, dass du es bist. Dein Passwort funktioniert danach nicht mehr.
        </p>
        <PasskeyAddressHint class="mb-4" />
        <button
          type="button"
          data-testid="enrol-create"
          :disabled="register.isPending.value"
          class="block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
          @click="onCreate"
        >
          {{ register.isPending.value ? "Warte auf Passkey…" : "Passkey erstellen" }}
        </button>
        <p v-if="error" class="mt-3 text-sm text-red-600" data-testid="enrol-error">{{ error }}</p>
        <button type="button" class="mt-5 text-xs text-ink-muted underline hover:text-ink" @click="onLogout">
          Abmelden
        </button>
      </template>
    </div>
  </div>
</template>
