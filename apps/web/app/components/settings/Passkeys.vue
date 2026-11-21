<script setup lang="ts">
/**
 * The member's passkeys: provider, synced or device-bound, address, last use;
 * add, rename, remove (never the last one). Changes need a passkey
 * confirmation, which `useApi` asks for and then repeats the action.
 */
const list = usePasskeyList();
const register = useRegisterPasskey();
const rename = useRenamePasskey();
const remove = useRemovePasskey();

const passkeys = computed(() => list.data.value ?? []);
const onlyOne = computed(() => passkeys.value.length === 1);
const editing = ref<number | null>(null);
const draft = ref("");
const message = ref<string | null>(null);

const error = computed(() => {
  for (const m of [register, rename, remove]) {
    if (m.isError.value) {
      if (statusOf(m.error.value) === 409 && m === remove) return "Der letzte Passkey kann nicht entfernt werden.";
      return passkeyErrorMessage(m.error.value, "Aktion fehlgeschlagen.");
    }
  }
  return null;
});

function startRename(id: number, name: string): void {
  editing.value = id;
  draft.value = name;
}

async function onRename(id: number): Promise<void> {
  const name = draft.value.trim();
  if (!name) return;
  try {
    await rename.mutateAsync({ id, name });
    editing.value = null;
  } catch {
    return;
  }
}

async function onRemove(id: number): Promise<void> {
  try {
    await remove.mutateAsync(id);
  } catch {
    return;
  }
}

async function onAdd(): Promise<void> {
  message.value = null;
  try {
    await register.mutateAsync({});
    message.value = "Passkey hinzugefügt.";
  } catch {
    return;
  }
}
</script>

<template>
  <div>
    <h3 class="text-xs font-semibold uppercase tracking-wide text-ink-muted">Passkeys</h3>
    <p
      v-if="onlyOne"
      data-testid="only-one-passkey"
      class="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      Du hast nur einen Passkey. Lege einen zweiten an (z. B. auf deinem Handy), damit du nicht nur
      auf die Wiederherstellungscodes angewiesen bist, wenn dieses Gerät verloren geht.
    </p>

    <ul class="mt-3 divide-y divide-hairline rounded-lg border border-hairline">
      <li v-for="p in passkeys" :key="p.id" data-testid="passkey-row" class="px-3 py-2 text-sm">
        <div class="flex items-center justify-between gap-3">
          <form v-if="editing === p.id" class="flex flex-1 gap-2" @submit.prevent="onRename(p.id)">
            <input
              v-model="draft"
              data-testid="passkey-name-input"
              maxlength="64"
              class="flex-1 rounded border border-hairline bg-surface px-2 py-1 text-sm text-ink"
            >
            <button type="submit" class="rounded border border-hairline px-2 py-1 text-xs font-medium">Speichern</button>
            <button type="button" class="text-xs text-ink-muted" @click="editing = null">Abbrechen</button>
          </form>
          <span v-else class="font-medium text-ink">{{ p.name }}</span>
          <span v-if="editing !== p.id" class="flex shrink-0 gap-2 text-xs">
            <button type="button" data-testid="passkey-rename" class="text-ink-muted underline" @click="startRename(p.id, p.name)">
              Umbenennen
            </button>
            <button
              type="button"
              data-testid="passkey-remove"
              :disabled="onlyOne || remove.isPending.value"
              :title="onlyOne ? 'Der letzte Passkey kann nicht entfernt werden' : undefined"
              class="text-red-700 underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
              @click="onRemove(p.id)"
            >
              Entfernen
            </button>
          </span>
        </div>
        <p class="mt-0.5 text-xs text-ink-subtle">
          {{ p.provider }} · {{ p.synced ? "synchronisiert" : "nur dieses Gerät" }} · {{ p.rp_id }} ·
          zuletzt verwendet {{ formatTimestamp(p.last_used_at) }}
        </p>
      </li>
      <li v-if="list.isPending.value" class="px-3 py-2 text-xs text-ink-subtle">Lädt…</li>
    </ul>

    <button
      type="button"
      data-testid="passkey-add"
      :disabled="register.isPending.value"
      class="mt-3 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-60"
      @click="onAdd"
    >
      {{ register.isPending.value ? "Warte auf Passkey…" : "Passkey hinzufügen" }}
    </button>
    <p class="mt-1 text-[11px] text-ink-faint">
      Ein Passkey gilt nur für die Adresse, auf der er angelegt wurde. Für eine weitere Adresse
      (z. B. Tailscale) dort einen Passkey hinzufügen.
    </p>
    <p v-if="message" class="mt-2 text-xs text-emerald-700" data-testid="passkey-message">{{ message }}</p>
    <p v-if="error" class="mt-2 text-xs text-red-600" data-testid="passkey-error">{{ error }}</p>
  </div>
</template>
