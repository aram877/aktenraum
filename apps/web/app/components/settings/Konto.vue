<script setup lang="ts">
/** Konto: passkeys, recovery codes, devices and access tokens (auth-passkeys, personal-access-tokens). */
</script>

<template>
  <div>
    <h2 class="font-serif text-2xl font-medium tracking-[-0.01em] text-ink">Konto</h2>
    <p class="mt-1 text-sm text-ink-subtle">
      Du meldest dich mit Passkeys an. Einstellungen hier werden mit einem Passkey bestätigt.
    </p>
    <SettingsPasskeys class="mt-5" />
    <SettingsWiederherstellung class="mt-6 border-t border-hairline pt-5" />
    <SettingsGeraete class="mt-6 border-t border-hairline pt-5" />
    <SettingsZugriffstokens class="mt-6 border-t border-hairline pt-5" />
  </div>
</template>
