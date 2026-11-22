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
  <div class="page-narrow max-w-4xl">
    <PageHeader eyebrow="Archiv" title="Papierkorb" subtitle="Gelöschte Dokumente bleiben 30 Tage wiederherstellbar.">
      <template v-if="rows.length > 0" #actions>
      <button
        type="button"
        :disabled="emptyTrash.isPending.value"
        data-testid="empty-trash"
        class="btn"
        :class="confirmingEmpty ? 'btn-danger border-red-300' : 'btn-secondary'"
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
      </template>
    </PageHeader>

    <p v-if="errorText" class="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ errorText }}
    </p>

    <p v-if="list.isPending.value" class="mt-10 text-center text-sm text-ink-subtle">Lade Papierkorb…</p>
    <p
      v-else-if="rows.length === 0"
      class="mt-10 py-10 text-center font-serif text-xl text-ink-subtle"
    >
      Der Papierkorb ist leer.
    </p>
    <template v-else>
      <div class="mt-8 flex items-baseline gap-3 border-b border-hairline px-1 pb-2.5">
        <h2 class="font-serif text-xl font-medium text-ink">Gelöscht</h2>
        <span class="text-xs text-ink-subtle">{{ total }} Dokument(e)</span>
      </div>
      <ul class="divide-y divide-hairline-soft">
        <li
          v-for="row in rows"
          :key="row.id"
          class="flex flex-wrap items-center gap-3 px-2 py-3"
        >
          <DocTypeTile :type="row.document_type ?? row.ai_document_type" class="opacity-70" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-ink">{{ row.title }}</p>
            <p class="mt-0.5 text-xs text-ink-muted">
              {{ row.document_type ?? row.ai_document_type ?? "—" }} ·
              {{ row.correspondent ?? row.ai_correspondent ?? "—" }} · {{ remaining(row) }}
            </p>
          </div>
          <button
            type="button"
            :disabled="restore.isPending.value"
            :data-testid="`restore-${row.id}`"
            class="btn btn-secondary btn-sm"
            @click="onRestore(row.id)"
          >
            Wiederherstellen
          </button>
          <button
            type="button"
            :disabled="deleteForever.isPending.value"
            :data-testid="`delete-${row.id}`"
            class="btn btn-sm"
            :class="confirmingDelete === row.id ? 'btn-danger border-red-300' : 'btn-ghost text-red-700'"
            @click="onDelete(row.id)"
          >
            {{ confirmingDelete === row.id ? "Wirklich?" : "Endgültig löschen" }}
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
