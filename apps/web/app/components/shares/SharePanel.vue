<script setup lang="ts">
import type { ShareEntry, ShareRole } from "~/composables/useShares";

/**
 * "Teilen" on the library detail page (tenancy-document-shares): the owner of
 * the document's home space lends it to another household member as viewer
 * or editor, optionally until a date. Rendered only for that owner.
 */
const props = defineProps<{ docId: number; spaceId: number }>();

const shares = useShares(() => props.docId);
const directory = useHouseholdDirectory();
const spaceMembers = useSpaceMembers(() => props.spaceId);
const showAudit = ref(false);
const audit = useShareAudit(() => props.docId, showAudit);

const grant = useGrantShare();
const change = useChangeShare();
const revoke = useRevokeShare();

const memberId = ref<number | null>(null);
const role = ref<ShareRole>("viewer");
const expiry = ref("");

/** Household members who can receive a share: not in the home space, not shared with yet. */
const candidates = computed(() => {
  const inSpace = new Set((spaceMembers.data.value ?? []).map((m) => m.member_id));
  const shared = new Set((shares.data.value ?? []).map((s) => s.member_id));
  return (directory.data.value ?? []).filter((m) => !inSpace.has(m.id) && !shared.has(m.id));
});

const today = computed(() => localDayOf(new Date().toISOString()));

const errorText = computed(() => {
  if (grant.isError.value) return detailFrom(grant.error.value, "Teilen fehlgeschlagen.");
  if (change.isError.value) return detailFrom(change.error.value, "Ändern fehlgeschlagen.");
  if (revoke.isError.value) return detailFrom(revoke.error.value, "Entziehen fehlgeschlagen.");
  return null;
});

async function onGrant(): Promise<void> {
  if (memberId.value === null) return;
  try {
    await grant.mutateAsync({
      docId: props.docId,
      memberId: memberId.value,
      role: role.value,
      expiresAt: endOfLocalDay(expiry.value),
    });
    memberId.value = null;
    role.value = "viewer";
    expiry.value = "";
  } catch {
    return;
  }
}

function onRole(share: ShareEntry, event: Event): void {
  const next = (event.target as HTMLSelectElement).value as ShareRole;
  void change.mutateAsync({ docId: props.docId, memberId: share.member_id, role: next }).catch(() => undefined);
}

function onExpiry(share: ShareEntry, event: Event): void {
  const day = (event.target as HTMLInputElement).value;
  void change
    .mutateAsync({ docId: props.docId, memberId: share.member_id, expiresAt: endOfLocalDay(day) })
    .catch(() => undefined);
}

function onRevoke(share: ShareEntry): void {
  void revoke.mutateAsync({ docId: props.docId, memberId: share.member_id }).catch(() => undefined);
}
</script>

<template>
  <section data-testid="share-panel" class="mt-4 rounded-lg border border-hairline bg-surface p-3">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-ink-muted">Teilen</h2>

    <ul v-if="(shares.data.value ?? []).length > 0" class="mt-2 flex flex-col gap-2" data-testid="share-list">
      <li
        v-for="share in shares.data.value"
        :key="share.member_id"
        class="flex flex-wrap items-center gap-2 text-sm"
        :data-testid="`share-${share.member_id}`"
      >
        <span class="font-medium text-ink">{{ share.username }}</span>
        <select
          :value="share.role"
          :aria-label="`Rolle von ${share.username}`"
          class="rounded-lg border border-hairline bg-surface px-2 py-1 text-xs"
          @change="onRole(share, $event)"
        >
          <option value="viewer">{{ SHARE_ROLE_LABELS.viewer }}</option>
          <option value="editor">{{ SHARE_ROLE_LABELS.editor }}</option>
        </select>
        <input
          type="date"
          :value="localDayOf(share.expires_at)"
          :min="today"
          :aria-label="`Ablauf für ${share.username}`"
          class="rounded-lg border border-hairline bg-surface px-2 py-1 text-xs"
          @change="onExpiry(share, $event)"
        >
        <button
          type="button"
          :data-testid="`revoke-${share.member_id}`"
          class="ml-auto rounded-lg border border-hairline px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          @click="onRevoke(share)"
        >
          Entziehen
        </button>
      </li>
    </ul>
    <p v-else-if="shares.isSuccess.value" class="mt-2 text-xs text-ink-subtle">Mit niemandem geteilt.</p>

    <form v-if="candidates.length > 0" class="mt-3 flex flex-wrap items-end gap-2" @submit.prevent="onGrant">
      <label class="text-xs font-medium text-ink-muted">
        Mitglied
        <select
          v-model="memberId"
          name="share-member"
          class="mt-1 block rounded-lg border border-hairline bg-surface px-2 py-1.5 text-sm"
        >
          <option :value="null" disabled>wählen…</option>
          <option v-for="m in candidates" :key="m.id" :value="m.id">{{ m.username }}</option>
        </select>
      </label>
      <label class="text-xs font-medium text-ink-muted">
        Rolle
        <select v-model="role" name="share-role" class="mt-1 block rounded-lg border border-hairline bg-surface px-2 py-1.5 text-sm">
          <option value="viewer">{{ SHARE_ROLE_LABELS.viewer }}</option>
          <option value="editor">{{ SHARE_ROLE_LABELS.editor }}</option>
        </select>
      </label>
      <label class="text-xs font-medium text-ink-muted">
        Bis (optional)
        <input
          v-model="expiry"
          type="date"
          name="share-expiry"
          :min="today"
          class="mt-1 block rounded-lg border border-hairline bg-surface px-2 py-1.5 text-sm"
        >
      </label>
      <button
        type="submit"
        data-testid="grant-share"
        :disabled="memberId === null || grant.isPending.value"
        class="rounded-lg bg-ink px-3 py-1.5 text-sm font-semibold text-surface disabled:opacity-50"
      >
        {{ grant.isPending.value ? "teile…" : "Teilen" }}
      </button>
    </form>

    <p v-if="errorText" role="alert" class="mt-2 text-xs text-red-700">{{ errorText }}</p>

    <button
      type="button"
      data-testid="toggle-audit"
      class="mt-3 text-xs font-medium text-ink-muted hover:text-ink"
      @click="showAudit = !showAudit"
    >
      {{ showAudit ? "Protokoll ausblenden" : "Protokoll anzeigen" }}
    </button>
    <ul v-if="showAudit" data-testid="share-audit" class="mt-2 flex flex-col gap-1 text-xs text-ink-muted">
      <li v-for="entry in audit.data.value ?? []" :key="entry.id">
        {{ auditLabel(entry) }} · {{ new Date(entry.at).toLocaleString("de-DE") }}
      </li>
      <li v-if="audit.isSuccess.value && (audit.data.value ?? []).length === 0">Noch keine Einträge.</li>
    </ul>
  </section>
</template>
