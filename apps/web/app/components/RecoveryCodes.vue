<script setup lang="ts">
/** Recovery codes, shown exactly once: copy, download as .txt, then continue. */
const props = defineProps<{ codes: string[]; username?: string; continueLabel?: string }>();
const emit = defineEmits<{ continue: [] }>();

const copied = ref(false);
const text = computed(() =>
  [
    `aktenraum — Wiederherstellungscodes${props.username ? ` für ${props.username}` : ""}`,
    "Jeder Code funktioniert genau einmal. Sicher aufbewahren (z. B. ausgedruckt oder im Passwortmanager).",
    "",
    ...props.codes,
  ].join("\n"),
);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

function download(): void {
  const url = URL.createObjectURL(new Blob([text.value], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "aktenraum-wiederherstellungscodes.txt";
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div data-testid="recovery-codes">
    <p class="text-sm font-semibold text-ink">Deine Wiederherstellungscodes</p>
    <p class="mt-1 text-xs text-ink-muted">
      Falls du keinen Passkey mehr hast (Gerät verloren, neuer Rechner), meldest du dich mit einem
      dieser Codes an und legst einen neuen Passkey an. Jeder Code funktioniert einmal. Sie werden
      nur jetzt angezeigt.
    </p>
    <ol class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-hairline bg-canvas px-4 py-3 font-mono text-sm text-ink">
      <li v-for="code in codes" :key="code" data-testid="recovery-code">{{ code }}</li>
    </ol>
    <div class="mt-3 flex flex-wrap gap-2 text-xs">
      <button type="button" class="rounded border border-hairline px-3 py-1.5 font-medium text-ink hover:bg-canvas" @click="copy">
        {{ copied ? "Kopiert ✓" : "Kopieren" }}
      </button>
      <button type="button" class="rounded border border-hairline px-3 py-1.5 font-medium text-ink hover:bg-canvas" @click="download">
        Als Datei speichern
      </button>
    </div>
    <button
      type="button"
      data-testid="codes-continue"
      class="mt-5 block w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-on-inverse hover:opacity-80"
      @click="emit('continue')"
    >
      {{ continueLabel ?? "Ich habe die Codes gesichert — weiter" }}
    </button>
  </div>
</template>
