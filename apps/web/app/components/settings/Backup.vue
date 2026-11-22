<script setup lang="ts">
const backup = useBackupStatus();
const notice = computed(() => backupNotice(backup.data.value));
const status = computed(() => backup.data.value ?? null);

const toneClass = computed(() => {
  switch (notice.value.tone) {
    case "ok":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "error":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-hairline bg-canvas text-ink-muted";
  }
});
</script>

<template>
  <div id="backup">
    <h2 class="font-serif text-2xl font-medium tracking-[-0.01em] text-ink">Backup</h2>
    <p class="mt-1 text-sm text-ink-subtle">
      Backups laufen automatisch: Sobald der Rechner an ist, wird stündlich geprüft und ein
      Backup erstellt, wenn das letzte älter als 20 Stunden ist.
    </p>

    <p v-if="backup.isPending.value" class="mt-4 text-sm text-ink-muted">Lädt…</p>
    <p
      v-else-if="backup.isError.value"
      data-testid="backup-error"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {{ detailFrom(backup.error.value, "Backup-Status konnte nicht geladen werden.") }}
    </p>
    <template v-else>
      <p data-testid="backup-summary" class="mt-4 rounded-lg border px-3 py-2 text-sm" :class="toneClass">
        {{ notice.summary }}
      </p>
      <dl v-if="status && status.state !== 'unknown'" class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt class="text-ink-muted">Letztes vollständiges Backup</dt>
        <dd class="text-ink" data-testid="backup-last">{{ formatBackupTime(status.last_backup_at) }}</dd>
        <dt class="text-ink-muted">Letzter Lauf</dt>
        <dd class="text-ink">
          {{ formatBackupTime(status.last_run_at) }}
          <span v-if="status.last_run_exit !== null && status.last_run_exit !== 0" class="text-red-600">
            (fehlgeschlagen, Exit {{ status.last_run_exit }})
          </span>
        </dd>
        <dt class="text-ink-muted">Zuletzt geprüft</dt>
        <dd class="text-ink">{{ formatBackupTime(status.checked_at) }}</dd>
      </dl>
      <p v-if="notice.tone === 'warn' || notice.tone === 'error'" class="mt-3 text-xs text-ink-muted">
        Details: <code class="rounded bg-canvas px-1">docker compose logs backup</code>
        <span v-if="status?.detail"> · {{ status.detail }}</span>
      </p>
    </template>
  </div>
</template>
