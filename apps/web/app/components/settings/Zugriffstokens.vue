<script setup lang="ts">
import type { TokenEntry, TokenScope } from "~/composables/useTokens";

/**
 * Personal access tokens (personal-access-tokens D10): for scripts and
 * integrations. Creating one asks for the passkey (step-up via `useApi`); the
 * value is shown once. Revoking is a two-click confirm.
 */
const tokensQuery = useTokens();
const create = useCreateToken();
const revoke = useRevokeToken();

const list = computed(() => tokensQuery.data.value ?? []);

// ---- create dialog -------------------------------------------------------
const EXPIRY_PRESETS = [30, 90, 365] as const;
const dialogOpen = ref(false);
const name = ref("");
const scopes = ref<TokenScope[]>([]);
const expiryChoice = ref<"30" | "90" | "365" | "custom">("90");
const customDays = ref<number | null>(null);
/** The new value — kept only until the panel is closed. */
const createdValue = ref<string | null>(null);
const copied = ref(false);

const expiresInDays = computed<number | null>(() => {
  if (expiryChoice.value !== "custom") return Number(expiryChoice.value);
  const days = customDays.value;
  return days !== null && Number.isInteger(days) && days >= 1 && days <= TOKEN_MAX_DAYS ? days : null;
});
const canSubmit = computed(
  () => name.value.trim().length > 0 && name.value.trim().length <= 64 && scopes.value.length > 0 && expiresInDays.value !== null,
);
const createError = computed(() =>
  create.isError.value ? passkeyErrorMessage(create.error.value, "Token konnte nicht erstellt werden.") : null,
);

function openDialog(): void {
  name.value = "";
  scopes.value = [];
  expiryChoice.value = "90";
  customDays.value = null;
  create.reset();
  dialogOpen.value = true;
}

function closeDialog(): void {
  dialogOpen.value = false;
}

async function onCreate(): Promise<void> {
  const days = expiresInDays.value;
  if (!canSubmit.value || days === null) return;
  try {
    const result = await create.mutateAsync({ name: name.value.trim(), scopes: [...scopes.value], expires_in_days: days });
    dialogOpen.value = false;
    copied.value = false;
    createdValue.value = result.value;
  } catch {
    return;
  }
}

async function onCopy(): Promise<void> {
  if (createdValue.value === null) return;
  try {
    await navigator.clipboard.writeText(createdValue.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

function closeCreated(): void {
  createdValue.value = null;
  copied.value = false;
}

// ---- revoke --------------------------------------------------------------
const confirmingId = ref<number | null>(null);

async function onRevoke(token: TokenEntry): Promise<void> {
  if (confirmingId.value !== token.id) {
    confirmingId.value = token.id;
    return;
  }
  try {
    await revoke.mutateAsync(token.id);
  } catch {
    return;
  } finally {
    confirmingId.value = null;
  }
}

const STATE_LABEL: Record<TokenEntry["state"], string> = { active: "aktiv", expired: "abgelaufen", revoked: "widerrufen" };
const STATE_CLASS: Record<TokenEntry["state"], string> = {
  active: "bg-emerald-50 text-emerald-800",
  expired: "bg-amber-50 text-amber-800",
  revoked: "bg-canvas text-ink-muted",
};
</script>

<template>
  <div data-testid="zugriffstokens">
    <h3 class="text-sm font-semibold text-ink">Zugriffstokens</h3>
    <p class="mt-0.5 text-xs text-ink-muted">
      Für Skripte und Integrationen (z. B. Scanner, Backups). Ein Token kann nur, was du ihm erlaubst, läuft spätestens
      nach einem Jahr ab und kann keine Anmeldungen oder Passkeys verwalten.
    </p>

    <!-- Show-once panel -->
    <div
      v-if="createdValue"
      data-testid="token-created"
      class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <p class="font-medium text-amber-900">Wird nur jetzt angezeigt — kopiere das Token jetzt.</p>
      <code data-testid="token-value" class="mt-2 block break-all rounded bg-surface px-2 py-1.5 font-mono text-xs text-ink">{{
        createdValue
      }}</code>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="token-copy"
          class="rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
          @click="onCopy"
        >
          {{ copied ? "Kopiert" : "Kopieren" }}
        </button>
        <button
          type="button"
          data-testid="token-created-close"
          class="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink"
          @click="closeCreated"
        >
          Fertig
        </button>
      </div>
    </div>

    <p v-if="tokensQuery.isPending.value" class="mt-3 text-sm text-ink-muted">lade…</p>
    <p v-else-if="tokensQuery.isError.value" data-testid="tokens-error" class="mt-3 text-sm text-red-700">
      Zugriffstokens konnten nicht geladen werden.
    </p>
    <p v-else-if="list.length === 0" data-testid="tokens-empty" class="mt-3 text-sm text-ink-muted">
      Noch keine Zugriffstokens.
    </p>
    <ul v-else class="mt-3 divide-y divide-hairline rounded-lg border border-hairline">
      <li
        v-for="token in list"
        :key="token.id"
        data-testid="token-row"
        class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
      >
        <div class="min-w-0">
          <p class="font-medium text-ink">
            {{ token.name }}
            <span class="ml-1 font-mono text-[11px] text-ink-faint">{{ token.display_prefix }}…</span>
            <span
              data-testid="token-state"
              :class="['ml-1 rounded-full px-2 py-0.5 text-[11px] font-medium', STATE_CLASS[token.state]]"
            >{{ STATE_LABEL[token.state] }}</span>
          </p>
          <p class="text-xs text-ink-muted">{{ token.scopes.map((s) => TOKEN_SCOPE_LABELS[s] ?? s).join(", ") }}</p>
          <p class="text-xs text-ink-muted" data-testid="token-usage">
            erstellt {{ formatTimestamp(token.created_at) }} ·
            <template v-if="token.state === 'revoked'">widerrufen {{ formatTimestamp(token.revoked_at) }}</template>
            <template v-else>{{ token.state === "expired" ? "abgelaufen" : "läuft ab" }} {{ formatTimestamp(token.expires_at) }}</template>
            ·
            <template v-if="token.last_used_at">
              zuletzt benutzt {{ formatTimestamp(token.last_used_at) }}<template v-if="token.last_used_ip"> von {{ token.last_used_ip }}</template>
            </template>
            <template v-else>nie benutzt</template>
          </p>
        </div>
        <button
          v-if="token.state === 'active'"
          type="button"
          data-testid="token-revoke"
          :disabled="revoke.isPending.value"
          class="h-10 rounded-lg border px-3 text-xs font-medium disabled:opacity-50 sm:h-auto sm:py-1"
          :class="confirmingId === token.id ? 'border-red-300 bg-red-50 text-red-800' : 'border-hairline text-ink hover:bg-canvas'"
          @click="onRevoke(token)"
        >
          {{ confirmingId === token.id ? "Wirklich widerrufen?" : "Widerrufen" }}
        </button>
      </li>
    </ul>
    <p v-if="revoke.isError.value" data-testid="token-revoke-error" class="mt-2 text-xs text-red-700">
      Widerrufen fehlgeschlagen. Bitte erneut versuchen.
    </p>

    <!-- Create dialog -->
    <form
      v-if="dialogOpen"
      data-testid="token-dialog"
      class="mt-3 space-y-3 rounded-lg border border-hairline p-3"
      @submit.prevent="onCreate"
    >
      <label class="block text-xs font-medium text-ink">
        Name
        <input
          v-model="name"
          data-testid="token-name"
          type="text"
          maxlength="64"
          placeholder="z. B. Scanner"
          class="mt-1 block w-full rounded-lg border border-hairline px-2 py-1.5 text-sm"
        >
      </label>
      <fieldset>
        <legend class="text-xs font-medium text-ink">Erlaubt</legend>
        <div class="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
          <label v-for="scope in TOKEN_SCOPES" :key="scope" class="flex items-center gap-2 text-sm text-ink">
            <input v-model="scopes" type="checkbox" :value="scope" :data-testid="`token-scope-${scope}`" >
            {{ TOKEN_SCOPE_LABELS[scope] }}
          </label>
        </div>
      </fieldset>
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-xs font-medium text-ink">
          Gültig
          <select
            v-model="expiryChoice"
            data-testid="token-expiry"
            class="mt-1 block rounded-lg border border-hairline px-2 py-1.5 text-sm"
          >
            <option v-for="days in EXPIRY_PRESETS" :key="days" :value="String(days)">{{ days }} Tage</option>
            <option value="custom">Eigene Dauer</option>
          </select>
        </label>
        <label v-if="expiryChoice === 'custom'" class="text-xs font-medium text-ink">
          Tage (1–{{ TOKEN_MAX_DAYS }})
          <input
            v-model.number="customDays"
            data-testid="token-custom-days"
            type="number"
            min="1"
            :max="TOKEN_MAX_DAYS"
            class="mt-1 block w-24 rounded-lg border border-hairline px-2 py-1.5 text-sm"
          >
        </label>
      </div>
      <p class="text-[11px] text-ink-faint">Zum Erstellen bestätigst du mit deinem Passkey.</p>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="token-submit"
          :disabled="!canSubmit || create.isPending.value"
          class="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          Token erstellen
        </button>
        <button type="button" class="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink" @click="closeDialog">
          Abbrechen
        </button>
        <span v-if="createError" data-testid="token-create-error" class="text-xs text-red-700">{{ createError }}</span>
      </div>
    </form>
    <button
      v-else
      type="button"
      data-testid="token-new"
      class="mt-3 rounded-lg border border-hairline px-3 py-2 text-xs font-medium text-ink hover:bg-canvas"
      @click="openDialog"
    >
      Neues Token
    </button>
  </div>
</template>
