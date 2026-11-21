<script setup lang="ts">
/** "Passkeys don't work here — use …" when the page is opened on an address without passkeys. */
const config = useWebauthnConfig();
const origin = ref("");
onMounted(() => {
  origin.value = window.location.origin;
});

const origins = computed(() => config.data.value?.origins ?? []);
const problem = computed(() =>
  origin.value === "" || origins.value.length === 0 ? null : passkeyAddressProblem(origin.value, origins.value),
);
</script>

<template>
  <div
    v-if="problem"
    data-testid="address-hint"
    class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
  >
    <p class="font-medium">
      {{ problem === "ip" ? "Passkeys funktionieren nicht auf IP-Adressen." : "Passkeys sind für diese Adresse nicht eingerichtet." }}
    </p>
    <p class="mt-1">
      Passkey-Anmeldung funktioniert hier:
      <template v-for="(entry, index) in origins" :key="entry">
        <a :href="entry" class="underline">{{ entry }}</a><span v-if="index < origins.length - 1">, </span>
      </template>
    </p>
  </div>
</template>
