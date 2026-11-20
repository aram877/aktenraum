<script setup lang="ts">
import type { SharedByMeEntry } from "~/composables/useShares";

definePageMeta({ middleware: "auth" });

const route = useRoute();
const { spaces, visible } = useSpacesVisible();
const tab = computed<"with-me" | "by-me">(() => (route.query.tab === "by-me" ? "by-me" : "with-me"));

const withMe = useSharedWithMe(() => visible.value && tab.value === "with-me");
const byMe = useSharedByMe(() => visible.value && tab.value === "by-me");
const revoke = useRevokeShare();
const openAudit = ref<number | null>(null);
const audit = useShareAudit(openAudit, () => openAudit.value !== null);

function selectTab(next: "with-me" | "by-me"): void {
  void navigateTo({ path: "/geteilt", query: next === "by-me" ? { tab: "by-me" } : {} });
}

function untilLabel(expiresAt: string | null): string {
  return expiresAt ? `bis ${formatShareDate(expiresAt)}` : "unbefristet";
}

function toggleAudit(docId: number): void {
  openAudit.value = openAudit.value === docId ? null : docId;
}

function onRevoke(entry: SharedByMeEntry): void {
  void revoke.mutateAsync({ docId: entry.doc_id, memberId: entry.member.id }).catch(() => undefined);
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
    <h1 class="text-lg font-semibold tracking-tight text-ink">Geteilt</h1>

    <p v-if="spaces.isPending.value" class="mt-4 text-xs text-ink-subtle">Lädt…</p>

    <p v-else-if="!visible" data-testid="geteilt-single" class="mt-2 text-sm text-ink-muted">
      Teilen gibt es, sobald ein zweites Mitglied zum Haushalt gehört.
    </p>

    <template v-else>
      <div class="mt-4 flex gap-2 text-sm" role="tablist">
        <button
          type="button"
          role="tab"
          data-testid="tab-with-me"
          :aria-selected="tab === 'with-me'"
          class="rounded-lg px-3 py-1.5"
          :class="tab === 'with-me' ? 'bg-ink font-semibold text-surface' : 'border border-hairline text-ink'"
          @click="selectTab('with-me')"
        >
          Mit mir geteilt
        </button>
        <button
          type="button"
          role="tab"
          data-testid="tab-by-me"
          :aria-selected="tab === 'by-me'"
          class="rounded-lg px-3 py-1.5"
          :class="tab === 'by-me' ? 'bg-ink font-semibold text-surface' : 'border border-hairline text-ink'"
          @click="selectTab('by-me')"
        >
          Von mir geteilt
        </button>
      </div>

      <section v-if="tab === 'with-me'" class="mt-5">
        <p v-if="withMe.isPending.value" class="text-xs text-ink-subtle">Lädt…</p>
        <p v-else-if="withMe.isError.value" role="alert" class="text-sm text-red-700">
          {{ detailFrom(withMe.error.value, "Liste konnte nicht geladen werden.") }}
        </p>
        <p v-else-if="(withMe.data.value ?? []).length === 0" data-testid="with-me-empty" class="text-sm text-ink-muted">
          Niemand hat dir bisher ein Dokument geteilt.
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="entry in withMe.data.value"
            :key="entry.doc_id"
            :data-testid="`with-me-${entry.doc_id}`"
            class="rounded-xl border border-hairline bg-surface p-3"
          >
            <NuxtLink :to="`/library/${entry.doc_id}`" class="text-sm font-medium text-ink">{{ entry.title }}</NuxtLink>
            <p class="mt-1 text-xs text-ink-muted">
              Geteilt von {{ entry.shared_by ?? "?" }} · {{ SHARE_ROLE_LABELS[entry.role] }} · {{ untilLabel(entry.expires_at) }}
            </p>
          </li>
        </ul>
      </section>

      <section v-else class="mt-5">
        <p v-if="byMe.isPending.value" class="text-xs text-ink-subtle">Lädt…</p>
        <p v-else-if="byMe.isError.value" role="alert" class="text-sm text-red-700">
          {{ detailFrom(byMe.error.value, "Liste konnte nicht geladen werden.") }}
        </p>
        <p v-else-if="(byMe.data.value ?? []).length === 0" data-testid="by-me-empty" class="text-sm text-ink-muted">
          Du hast noch nichts geteilt. Teilen kannst du auf der Detailseite eines Dokuments.
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="entry in byMe.data.value"
            :key="`${entry.doc_id}-${entry.member.id}`"
            :data-testid="`by-me-${entry.doc_id}-${entry.member.id}`"
            class="rounded-xl border border-hairline bg-surface p-3"
          >
            <div class="flex flex-wrap items-center gap-2">
              <NuxtLink :to="`/library/${entry.doc_id}`" class="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {{ entry.title }}
              </NuxtLink>
              <button
                type="button"
                class="text-xs font-medium text-ink-muted hover:text-ink"
                :data-testid="`audit-${entry.doc_id}`"
                @click="toggleAudit(entry.doc_id)"
              >
                Protokoll
              </button>
              <button
                type="button"
                :data-testid="`revoke-${entry.doc_id}-${entry.member.id}`"
                class="rounded-lg border border-hairline px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                @click="onRevoke(entry)"
              >
                Entziehen
              </button>
            </div>
            <p class="mt-1 text-xs text-ink-muted">
              mit {{ entry.member.username }} · {{ SHARE_ROLE_LABELS[entry.role] }} · {{ untilLabel(entry.expires_at) }}
            </p>
            <ul v-if="openAudit === entry.doc_id" class="mt-2 flex flex-col gap-1 text-xs text-ink-muted" data-testid="by-me-audit">
              <li v-for="item in audit.data.value ?? []" :key="item.id">
                {{ auditLabel(item) }} · {{ new Date(item.at).toLocaleString("de-DE") }}
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="revoke.isError.value" role="alert" class="mt-2 text-xs text-red-700">
          {{ detailFrom(revoke.error.value, "Entziehen fehlgeschlagen.") }}
        </p>
      </section>
    </template>
  </div>
</template>
