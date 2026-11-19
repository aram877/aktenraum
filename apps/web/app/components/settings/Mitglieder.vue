<script setup lang="ts">
import type { CreatedInvite } from "~/composables/useHousehold";

/** Household members + invite links. Rendered for the household admin only. */
const membersQuery = useHouseholdMembers(true);
const invitesQuery = usePendingInvites(true);
const create = useCreateInvite();
const revoke = useRevokeInvite();

const created = ref<CreatedInvite | null>(null);
const copied = ref(false);

const createdUrl = computed(() => (created.value ? inviteUrl(created.value.token) : ""));

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
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
        class="flex items-center justify-between px-3 py-2 text-sm"
      >
        <span class="font-medium text-ink">{{ member.username }}</span>
        <span class="text-xs text-ink-subtle">
          {{ member.role === "admin" ? "Verwaltung" : "Mitglied" }} · seit {{ formatDate(member.joined_at) }}
        </span>
      </li>
      <li v-if="membersQuery.isPending.value" class="px-3 py-2 text-xs text-ink-subtle">Lädt…</li>
    </ul>

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
  </div>
</template>
