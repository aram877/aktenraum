<script setup lang="ts">
// No guest middleware: a setup link may be opened by someone still signed in elsewhere.
definePageMeta({ layout: "bare" });

/**
 * Setup link (auth-passkeys): first run, or a member who lost every passkey
 * and code. Creates a passkey, shows a new set of recovery codes, signs in.
 */
const route = useRoute();
const token = computed(() => String(route.params.token ?? ""));

const check = useSetupCheck(token);
const enrol = useSetupEnrol(token);
const codes = ref<string[] | null>(null);
const done = ref(false);

const invalid = computed(() => check.isError.value && statusOf(check.error.value) === 404);
const error = computed(() => {
  if (!enrol.isError.value) return null;
  if (statusOf(enrol.error.value) === 404) return "Der Einrichtungslink ist nicht mehr gültig.";
  return passkeyErrorMessage(enrol.error.value, "Passkey konnte nicht angelegt werden.");
});

async function onCreate(): Promise<void> {
  try {
    const result = await enrol.mutateAsync();
    codes.value = result.recovery_codes;
    done.value = true;
  } catch {
    return;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-md rounded-2xl border border-hairline bg-surface p-8">
      <AppLogo :size="52" class="mb-5" />
      <h1 class="mb-1 font-serif text-3xl font-medium tracking-[-0.02em] text-ink">aktenraum einrichten</h1>

      <template v-if="done">
        <RecoveryCodes
          v-if="codes && codes.length > 0"
          class="mt-4"
          :codes="codes"
          :username="check.data.value?.username"
          @continue="navigateTo('/')"
        />
        <p class="mt-4 text-xs text-ink-muted" data-testid="setup-other-devices">
          Falls ein verlorenes Gerät noch angemeldet ist:
          <NuxtLink to="/settings#konto" class="underline">Andere Geräte abmelden</NuxtLink>
        </p>
      </template>

      <p v-else-if="check.isPending.value" class="text-sm text-ink-subtle">Link wird geprüft…</p>

      <div v-else-if="check.isError.value" data-testid="setup-invalid">
        <p class="mt-4 text-sm text-ink">
          {{
            invalid
              ? "Dieser Einrichtungslink ist ungültig, abgelaufen oder wurde schon verwendet."
              : detailFrom(check.error.value, "Link konnte nicht geprüft werden.")
          }}
        </p>
        <p class="mt-2 text-xs text-ink-subtle">Bitte um einen neuen Link (gültig 30 Minuten).</p>
      </div>

      <template v-else>
        <p class="mb-5 text-sm text-ink-subtle">
          Lege einen Passkey für <strong class="text-ink" data-testid="setup-username">{{ check.data.value?.username }}</strong>
          an — Windows Hello, dein Handy oder dein Passwortmanager. Danach bekommst du neue
          Wiederherstellungscodes; alte Codes funktionieren nicht mehr.
        </p>
        <PasskeyAddressHint class="mb-4" />
        <button
          type="button"
          data-testid="setup-create"
          :disabled="enrol.isPending.value"
          class="block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
          @click="onCreate"
        >
          {{ enrol.isPending.value ? "Warte auf Passkey…" : "Passkey erstellen" }}
        </button>
        <p v-if="error" class="mt-3 text-sm text-red-600" data-testid="setup-error">{{ error }}</p>
      </template>
    </div>
  </div>
</template>
