<script setup lang="ts">
import type { CreatedInvite, HouseholdMember, RemovalPreview } from "~/composables/useHousehold";

/** Household members + invite links + member removal. Rendered for the household admin only. */
const membersQuery = useHouseholdMembers(true);
const invitesQuery = usePendingInvites(true);
const removalsQuery = useRemovals(true);
const create = useCreateInvite();
const revoke = useRevokeInvite();
const removeMember = useRemoveMember();
const createSetup = useCreateSetupLink();
const setupLink = ref<{ username: string; url: string; expires_at: string } | null>(null);
const setupCopied = ref(false);

async function onCreateSetupLink(member: HouseholdMember): Promise<void> {
  setupLink.value = null;
  setupCopied.value = false;
  try {
    const created = await createSetup.mutateAsync(member.id);
    setupLink.value = { username: member.username, url: setupUrl(created.token), expires_at: created.expires_at };
  } catch {
    return;
  }
}

async function copySetupLink(): Promise<void> {
  if (!setupLink.value) return;
  try {
    await navigator.clipboard.writeText(setupLink.value.url);
    setupCopied.value = true;
  } catch {
    setupCopied.value = false;
  }
}

const created = ref<CreatedInvite | null>(null);
const copied = ref(false);

const createdUrl = computed(() => (created.value ? inviteUrl(created.value.token) : ""));

// ------------------------------------------------------------ remove dialog
const removing = ref<HouseholdMember | null>(null);
const successorId = ref<number | null>(null);
const confirmText = ref("");
const previewQuery = useRemovalPreview(
  () => removing.value?.id ?? null,
  () => successorId.value,
);
const successorOptions = computed(() =>
  (membersQuery.data.value ?? []).filter((m) => m.id !== removing.value?.id),
);
const confirmMatches = computed(
  () => removing.value !== null && confirmText.value.trim() === removing.value.username,
);
const incompleteRemovals = computed(() => (removalsQuery.data.value ?? []).filter((r) => r.status !== "done"));

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function openRemove(member: HouseholdMember): void {
  removing.value = member;
  // Default successor: me (the household admin — the only one who sees this).
  successorId.value = (membersQuery.data.value ?? []).find((m) => m.role === "admin")?.id ?? null;
  confirmText.value = "";
  removeMember.reset();
}

function closeRemove(): void {
  removing.value = null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function previewLines(p: RemovalPreview): string[] {
  const trashed = p.trashed ? ` (davon ${p.trashed} im Papierkorb)` : "";
  const lines = [`${p.documents} ${plural(p.documents, "Dokument geht", "Dokumente gehen")} an ${p.successor}${trashed}.`];
  for (const space of p.spaces_owned) lines.push(`${p.successor} wird Eigentümer von „${space.name}“.`);
  if (p.spaces_left.length > 0) {
    lines.push(`${p.username} verlässt ${p.spaces_left.map((s) => `„${s.name}“`).join(", ")}.`);
  }
  if (p.shares_revoked > 0) {
    lines.push(`${p.shares_revoked} ${plural(p.shares_revoked, "Freigabe endet", "Freigaben enden")}.`);
  }
  if (p.shares_kept > 0) {
    lines.push(
      `${p.shares_kept} ${plural(p.shares_kept, "Freigabe bleibt", "Freigaben bleiben")} bestehen, verwaltet von ${p.successor}.`,
    );
  }
  return lines;
}

async function onConfirmRemove(): Promise<void> {
  const member = removing.value;
  if (member === null || !confirmMatches.value) return;
  try {
    await removeMember.mutateAsync({
      memberId: member.id,
      confirmUsername: confirmText.value.trim(),
      successorId: successorId.value,
    });
  } catch {
    return;
  }
  removing.value = null;
}

async function onCreate(): Promise<void> {
  copied.value = false;
  try {
    created.value = await create.mutateAsync();
  } catch {
    return;
  }
}

async function onCopy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(createdUrl.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

async function onRevoke(id: number): Promise<void> {
  try {
    await revoke.mutateAsync(id);
    if (created.value?.id === id) created.value = null;
  } catch {
    return;
  }
}
</script>

<template>
  <div data-testid="mitglieder">
    <h2 class="text-sm font-semibold text-ink">Mitglieder</h2>
    <p class="mt-0.5 text-xs text-ink-muted">
      Wer zum Haushalt gehört. Neue Mitglieder kommen über einen Einladungslink dazu und haben
      ihre eigene, private Akte.
    </p>

    <ul class="mt-4 divide-y divide-hairline rounded-lg border border-hairline">
      <li
        v-for="member in membersQuery.data.value ?? []"
        :key="member.id"
        data-testid="member-row"
        class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
      >
        <span class="font-medium text-ink">{{ member.username }}</span>
        <span class="flex items-center gap-3 text-xs text-ink-subtle">
          {{ member.role === "admin" ? "Verwaltung" : "Mitglied" }} · seit {{ formatDate(member.joined_at) }}
          <button
            type="button"
            data-testid="create-setup-link"
            :disabled="createSetup.isPending.value"
            title="Für jemanden, der keinen Passkey und keinen Wiederherstellungscode mehr hat"
            class="rounded border border-hairline px-2 py-1 font-medium text-ink hover:bg-canvas disabled:opacity-60"
            @click="onCreateSetupLink(member)"
          >
            Einrichtungslink erstellen
          </button>
          <button
            v-if="member.role !== 'admin'"
            type="button"
            data-testid="remove-member"
            class="rounded border border-hairline px-2 py-1 font-medium text-red-700 hover:bg-red-50"
            @click="openRemove(member)"
          >
            Entfernen
          </button>
        </span>
      </li>
      <li v-if="membersQuery.isPending.value" class="px-3 py-2 text-xs text-ink-subtle">Lädt…</li>
    </ul>

    <div
      v-if="setupLink"
      data-testid="setup-link"
      class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-950"
    >
      <p class="font-semibold">Einrichtungslink für {{ setupLink.username }}</p>
      <p class="mt-1">
        Einmalig, 30 Minuten gültig. Wird nur jetzt angezeigt — persönlich weitergeben. Damit legt
        {{ setupLink.username }} einen neuen Passkey an und bekommt neue Wiederherstellungscodes.
      </p>
      <div class="mt-2 flex items-center gap-2">
        <input
          :value="setupLink.url"
          readonly
          data-testid="setup-link-url"
          class="flex-1 rounded border border-amber-200 bg-white px-2 py-1 font-mono text-[11px] text-ink"
        >
        <button type="button" class="rounded border border-amber-300 px-2 py-1 font-medium" @click="copySetupLink">
          {{ setupCopied ? "Kopiert ✓" : "Kopieren" }}
        </button>
      </div>
    </div>
    <p v-if="createSetup.isError.value" class="mt-2 text-xs text-red-600" data-testid="setup-link-error">
      {{ passkeyErrorMessage(createSetup.error.value, "Einrichtungslink konnte nicht erstellt werden.") }}
    </p>

    <div
      v-if="removing"
      data-testid="remove-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`${removing.username} entfernen`"
      class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-950"
    >
      <p class="font-semibold">{{ removing.username }} aus dem Haushalt entfernen</p>
      <p class="mt-1">
        Der Zugang endet sofort. Dokumente, Akten und Freigaben gehen an die Nachfolge. Das lässt
        sich nicht rückgängig machen.
      </p>
      <label class="mt-3 block font-medium">
        Nachfolge
        <select
          v-model="successorId"
          data-testid="remove-successor"
          class="mt-1 block w-full rounded border border-red-200 bg-white px-2 py-1 text-ink"
        >
          <option v-for="option in successorOptions" :key="option.id" :value="option.id">
            {{ option.username }}{{ option.role === "admin" ? " (ich)" : "" }}
          </option>
        </select>
      </label>
      <ul v-if="previewQuery.data.value" data-testid="remove-preview" class="mt-3 list-disc space-y-0.5 pl-4">
        <li v-for="line in previewLines(previewQuery.data.value)" :key="line">{{ line }}</li>
      </ul>
      <p v-else-if="previewQuery.isError.value" class="mt-3 text-red-700">
        {{ detailFrom(previewQuery.error.value, "Vorschau nicht verfügbar.") }}
      </p>
      <p v-else class="mt-3 text-ink-subtle">Vorschau lädt…</p>
      <label class="mt-3 block font-medium">
        Zur Bestätigung „{{ removing.username }}“ eingeben
        <input
          v-model="confirmText"
          data-testid="remove-confirm"
          autocomplete="off"
          class="mt-1 block w-full rounded border border-red-200 bg-white px-2 py-1 text-ink"
        >
      </label>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="remove-submit"
          :disabled="!confirmMatches || removeMember.isPending.value"
          class="rounded-lg bg-red-700 px-3 py-1.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          @click="onConfirmRemove"
        >
          {{ removeMember.isPending.value ? "Entferne…" : "Endgültig entfernen" }}
        </button>
        <button type="button" class="rounded border border-red-200 px-3 py-1.5 font-medium" @click="closeRemove">
          Abbrechen
        </button>
        <span v-if="removeMember.isError.value" data-testid="remove-error" class="text-red-700">
          {{ detailFrom(removeMember.error.value, "Entfernen fehlgeschlagen.") }}
        </span>
      </div>
    </div>

    <div class="mt-5 flex items-center gap-3">
      <button
        type="button"
        data-testid="create-invite"
        :disabled="create.isPending.value"
        class="rounded-lg bg-ink px-4 py-1.5 text-xs font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-50"
        @click="onCreate"
      >
        {{ create.isPending.value ? "Erstelle…" : "Einladungslink erstellen" }}
      </button>
      <span v-if="create.isError.value" class="text-xs text-red-600" data-testid="invite-error">
        {{ detailFrom(create.error.value, "Link konnte nicht erstellt werden.") }}
      </span>
    </div>

    <div
      v-if="created"
      data-testid="invite-link"
      class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900"
    >
      <p class="font-medium">Link wird nur jetzt angezeigt — jetzt kopieren und weitergeben.</p>
      <div class="mt-2 flex items-center gap-2">
        <input
          :value="createdUrl"
          readonly
          data-testid="invite-url"
          class="min-w-0 flex-1 rounded border border-amber-200 bg-white px-2 py-1 font-mono text-[11px] text-ink"
          @focus="($event.target as HTMLInputElement).select()"
        >
        <button
          type="button"
          class="rounded border border-amber-300 px-2 py-1 font-medium hover:bg-amber-100"
          @click="onCopy"
        >
          {{ copied ? "Kopiert ✓" : "Kopieren" }}
        </button>
      </div>
      <p class="mt-2">Einmalig gültig bis {{ formatDate(created.expires_at) }}.</p>
    </div>

    <div v-if="(invitesQuery.data.value ?? []).length > 0" class="mt-5">
      <h3 class="text-xs font-semibold text-ink-muted">Offene Einladungen</h3>
      <ul class="mt-2 divide-y divide-hairline rounded-lg border border-hairline">
        <li
          v-for="invite in invitesQuery.data.value"
          :key="invite.id"
          data-testid="invite-row"
          class="flex items-center justify-between px-3 py-2 text-xs"
        >
          <span class="text-ink">Erstellt {{ formatDate(invite.created_at) }} · gültig bis {{ formatDate(invite.expires_at) }}</span>
          <button
            type="button"
            data-testid="revoke-invite"
            :disabled="revoke.isPending.value"
            class="rounded border border-hairline px-2 py-1 font-medium text-ink hover:bg-canvas disabled:opacity-50"
            @click="onRevoke(invite.id)"
          >
            Widerrufen
          </button>
        </li>
      </ul>
    </div>

    <div v-if="(removalsQuery.data.value ?? []).length > 0" class="mt-5" data-testid="removals">
      <h3 class="text-xs font-semibold text-ink-muted">Entfernte Mitglieder</h3>
      <ul class="mt-2 divide-y divide-hairline rounded-lg border border-hairline">
        <li
          v-for="removal in removalsQuery.data.value"
          :key="removal.member_id"
          data-testid="removal-row"
          class="flex items-center justify-between gap-3 px-3 py-2 text-xs"
        >
          <span class="text-ink">
            {{ removal.username }} · entfernt am {{ formatDate(removal.removed_at) }} · Nachfolge {{ removal.successor }}
          </span>
          <span
            v-if="removal.status !== 'done'"
            data-testid="removal-completing"
            :title="removal.last_error ?? undefined"
            class="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800"
          >
            wird abgeschlossen
          </span>
        </li>
      </ul>
      <p v-if="incompleteRemovals.length > 0" class="mt-1 text-[11px] text-ink-subtle">
        Paperless und die Suche werden noch angeglichen; das läuft automatisch weiter.
      </p>
    </div>
  </div>
</template>
