<script setup lang="ts">
import type { SessionEntry } from "~/composables/useSessions";

/** Where the member is signed in; sign out one device or all others. */
const sessionsQuery = useSessions();
const revoke = useRevokeSession();
const revokeOthers = useRevokeOtherSessions();

const list = computed(() => sessionsQuery.data.value ?? []);
const others = computed(() => list.value.filter((s) => !s.current).length);
const busy = computed(() => revoke.isPending.value || revokeOthers.isPending.value);

async function onRevoke(session: SessionEntry): Promise<void> {
  try {
    await revoke.mutateAsync({ id: session.id, current: session.current });
    if (session.current) await navigateTo("/login");
  } catch {
    return;
  }
}

async function onRevokeOthers(): Promise<void> {
  try {
    await revokeOthers.mutateAsync();
  } catch {
    return;
  }
}
</script>

<template>
  <div data-testid="geraete">
    <h3 class="font-serif text-lg font-medium text-ink">Geräte</h3>
    <p class="mt-1 text-sm text-ink-subtle">
      Wo du angemeldet bist. Eine Anmeldung läuft nach 7 Tagen ohne Nutzung ab, spätestens nach 30 Tagen.
    </p>

    <p v-if="sessionsQuery.isPending.value" class="mt-3 text-sm text-ink-muted">lade…</p>
    <p
      v-else-if="sessionsQuery.isError.value"
      data-testid="geraete-error"
      class="mt-3 text-sm text-red-700"
    >
      Geräte konnten nicht geladen werden.
    </p>

    <ul v-else class="mt-3 divide-y divide-hairline rounded-lg border border-hairline">
      <li
        v-for="session in list"
        :key="session.id"
        data-testid="session-row"
        class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
      >
        <div class="min-w-0">
          <p class="font-medium text-ink">
            {{ deviceLabel(session.user_agent) }}
            <span
              v-if="session.current"
              data-testid="session-current"
              class="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800"
            >dieses Gerät</span>
          </p>
          <p class="text-xs text-ink-muted">
            <span v-if="session.ip">{{ session.ip }} · </span>angemeldet {{ formatTimestamp(session.created_at) }} ·
            zuletzt aktiv {{ formatTimestamp(session.last_seen_at) }}
          </p>
        </div>
        <button
          type="button"
          data-testid="session-revoke"
          :disabled="busy"
          class="h-10 rounded-lg border border-hairline px-3 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50 sm:h-auto sm:py-1"
          @click="onRevoke(session)"
        >
          Abmelden
        </button>
      </li>
    </ul>

    <div class="mt-3 flex flex-wrap items-center gap-3">
      <button
        v-if="others > 0"
        type="button"
        data-testid="session-revoke-others"
        :disabled="busy"
        class="rounded-lg border border-hairline px-3 py-2 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50"
        @click="onRevokeOthers"
      >
        Alle anderen Geräte abmelden
      </button>
      <span v-if="revoke.isError.value || revokeOthers.isError.value" data-testid="session-revoke-error" class="text-xs text-red-700">
        Abmelden fehlgeschlagen. Bitte erneut versuchen.
      </span>
    </div>
  </div>
</template>
