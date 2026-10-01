<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const list = useTrashList();
const restore = useRestore();
const deleteForever = useDeleteForever();
const emptyTrash = useEmptyTrash();

const confirmingDelete = ref<number | null>(null);
const confirmingEmpty = ref(false);

const rows = computed<readonly TrashItem[]>(() => list.data.value?.results ?? []);
const total = computed(() => list.data.value?.total ?? 0);

const errorText = computed(() => {
  if (restore.isError.value) return detailFrom(restore.error.value, "Wiederherstellen fehlgeschlagen.");
  if (deleteForever.isError.value) return detailFrom(deleteForever.error.value, "Löschen fehlgeschlagen.");
  if (emptyTrash.isError.value) return detailFrom(emptyTrash.error.value, "Leeren fehlgeschlagen.");
  return null;
});

function remaining(item: TrashItem): string {
  const days = daysLeft(item.deleted_at);
  return days === null ? "—" : `noch ${days} Tage`;
}

async function onRestore(id: number): Promise<void> {
  await restore.mutateAsync(id).catch(() => undefined);
}

async function onDelete(id: number): Promise<void> {
  if (confirmingDelete.value !== id) {
    confirmingDelete.value = id;
    return;
  }
  confirmingDelete.value = null;
  await deleteForever.mutateAsync(id).catch(() => undefined);
}

async function onEmpty(): Promise<void> {
  if (!confirmingEmpty.value) {
    confirmingEmpty.value = true;
    return;
  }
  confirmingEmpty.value = false;
  await emptyTrash.mutateAsync().catch(() => undefined);
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
    <div class="flex items-baseline justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold tracking-tight text-ink">Papierkorb</h1>
        <p class="mt-0.5 text-xs text-ink-muted">Gelöschte Dokumente bleiben 30 Tage wiederherstellbar.</p>
      </div>
      <button
        v-if="rows.length > 0"
        type="button"
        :disabled="emptyTrash.isPending.value"
        data-testid="empty-trash"
        class="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        :class="confirmingEmpty ? 'border-red-300 text-red-700' : 'border-hairline text-ink'"
        @click="onEmpty"
      >
        {{
          emptyTrash.isPending.value
            ? "leere…"
            : confirmingEmpty
              ? "Wirklich? Erneut klicken"
              : "Papierkorb leeren"
        }}
      </button>
    </div>

    <p v-if="errorText" class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ errorText }}
    </p>

    <p v-if="list.isPending.value" class="mt-6 text-xs text-ink-subtle">Lade Papierkorb…</p>
    <p
      v-else-if="rows.length === 0"
      class="mt-6 rounded-lg border border-dashed border-hairline bg-surface p-8 text-center text-sm text-ink-subtle"
    >
      Der Papierkorb ist leer.
    </p>
    <template v-else>
      <p class="mt-4 text-xs text-ink-subtle">{{ total }} Dokument(e)</p>
      <ul class="mt-2 flex flex-col gap-2">
        <li
          v-for="row in rows"
          :key="row.id"
          class="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-surface p-3"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-ink">{{ row.title }}</p>
            <p class="mt-0.5 text-xs text-ink-muted">
              {{ row.document_type ?? row.ai_document_type ?? "—" }} ·
              {{ row.correspondent ?? row.ai_correspondent ?? "—" }} · {{ remaining(row) }}
            </p>
          </div>
          <button
            type="button"
            :disabled="restore.isPending.value"
            :data-testid="`restore-${row.id}`"
            class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:opacity-50"
            @click="onRestore(row.id)"
          >
            Wiederherstellen
          </button>
          <button
            type="button"
            :disabled="deleteForever.isPending.value"
            :data-testid="`delete-${row.id}`"
            class="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            :class="confirmingDelete === row.id ? 'border-red-300 text-red-700' : 'border-hairline text-ink'"
            @click="onDelete(row.id)"
          >
            {{ confirmingDelete === row.id ? "Wirklich?" : "Endgültig löschen" }}
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
