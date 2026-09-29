<script setup lang="ts">
definePageMeta({ layout: "bare", middleware: "guest" });

const login = useLogin();
const username = ref("");
const password = ref("");

async function onSubmit(): Promise<void> {
  try {
    await login.mutateAsync({ username: username.value, password: password.value });
    await navigateTo("/");
  } catch {
    return;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <form
      class="w-full max-w-sm rounded-xl border border-hairline bg-surface p-8"
      @submit.prevent="onSubmit"
    >
      <h1 class="mb-1 text-xl font-semibold tracking-tight text-ink">aktenraum</h1>
      <p class="mb-7 text-sm text-ink-subtle">Melde dich an, um fortzufahren.</p>

      <label class="block text-xs font-medium text-ink-muted">
        Benutzername
        <input
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          required
          class="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        >
      </label>
      <label class="mt-4 block text-xs font-medium text-ink-muted">
        Passwort
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
          class="mt-1.5 block w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        >
      </label>

      <p v-if="login.isError.value" class="mt-3 text-sm text-red-600" data-testid="login-error">
        Ungültige Anmeldedaten. Bitte erneut versuchen.
      </p>

      <button
        type="submit"
        :disabled="login.isPending.value"
        class="mt-6 block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80 disabled:opacity-60"
      >
        {{ login.isPending.value ? "Anmelden…" : "Anmelden" }}
      </button>
    </form>
  </div>
</template>
