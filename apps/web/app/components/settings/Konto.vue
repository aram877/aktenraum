<script setup lang="ts">
/** Konto: passkeys, recovery codes, devices and access tokens (auth-passkeys, personal-access-tokens). */
</script>

<template>
  <div>
    <h2 class="text-sm font-semibold text-ink">Konto</h2>
    <p class="mt-0.5 text-xs text-ink-muted">
      Du meldest dich mit Passkeys an. Einstellungen hier werden mit einem Passkey bestätigt.
    </p>
    <SettingsPasskeys class="mt-5" />
    <SettingsWiederherstellung class="mt-6 border-t border-hairline pt-5" />
    <SettingsGeraete class="mt-6 border-t border-hairline pt-5" />
    <SettingsZugriffstokens class="mt-6 border-t border-hairline pt-5" />
  </div>
</template>
