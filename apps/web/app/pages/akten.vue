<script setup lang="ts">
import type { SpaceSummary } from "~/composables/useSpaces";

definePageMeta({ middleware: "auth" });

const me = useMe();
const api = useApi();
const { spaces, visible } = useSpacesVisible();
const create = useCreateSpace();
const rename = useRenameSpace();
const remove = useDeleteSpace();
const leave = useRemoveSpaceMember();

const ROLE_LABEL: Record<string, string> = { owner: "Eigentümer", editor: "Bearbeiten", viewer: "Nur lesen" };

const list = computed(() => spaces.data.value?.spaces ?? []);

const newName = ref("");
const error = ref<string | null>(null);
const renaming = ref<number | null>(null);
const renameValue = ref("");
const openMembers = ref<number | null>(null);

async function run(work: () => Promise<unknown>, fallback: string): Promise<boolean> {
  error.value = null;
  try {
    await work();
    return true;
  } catch (e: unknown) {
    error.value = detailFrom(e, fallback);
    return false;
  }
}

async function onCreate(): Promise<void> {
  const name = newName.value.trim();
  if (name === "") return;
  if (await run(() => create.mutateAsync(name), "Akte konnte nicht angelegt werden.")) newName.value = "";
}

function startRename(space: SpaceSummary): void {
  renaming.value = space.id;
  renameValue.value = space.name;
}

async function onRename(space: SpaceSummary): Promise<void> {
  const name = renameValue.value.trim();
  if (name === "" || name === space.name) {
    renaming.value = null;
    return;
  }
  if (await run(() => rename.mutateAsync({ id: space.id, name }), "Umbenennen fehlgeschlagen.")) {
    renaming.value = null;
  }
}

function onDelete(space: SpaceSummary): Promise<boolean> {
  return run(() => remove.mutateAsync(space.id), "Akte konnte nicht gelöscht werden.");
}

/** The caller's own member id, from the space's member list (the session only knows the username). */
async function onLeave(space: SpaceSummary): Promise<void> {
  await run(async () => {
    const members = await api.get<{ member_id: number; username: string }[]>(`/spaces/${space.id}/members`);
    const self = members.find((m) => m.username === me.data.value?.username);
    if (self === undefined) throw new Error("Mitgliedschaft nicht gefunden.");
    await leave.mutateAsync({ spaceId: space.id, memberId: self.member_id });
  }, "Verlassen fehlgeschlagen.");
}
</script>

<template>
  <div class="page-narrow">
    <PageHeader eyebrow="Haushalt" title="Akten" />

    <p v-if="spaces.isPending.value" class="mt-8 text-sm text-ink-subtle">Lädt…</p>

    <p v-else-if="!visible" data-testid="akten-single" class="mt-8 font-serif text-lg text-ink-subtle">
      Gemeinsame Akten gibt es, sobald ein zweites Mitglied zum Haushalt gehört. Bis dahin liegen
      alle Dokumente in deiner persönlichen Akte.
    </p>

    <template v-else>
      <p class="mt-3 max-w-2xl text-sm text-ink-subtle">
        Was ihr gemeinsam verwaltet, kommt in eine gemeinsame Akte. Der Eigentümer entscheidet, wer
        mitliest oder mitbearbeitet.
      </p>

      <form class="mt-8 flex gap-2" data-testid="akte-create" @submit.prevent="onCreate">
        <input
          v-model="newName"
          maxlength="128"
          placeholder="Neue Akte, z. B. Haushalt"
          data-testid="akte-name"
          class="field min-w-0 flex-1"
        >
        <button
          type="submit"
          :disabled="newName.trim() === '' || create.isPending.value"
          class="btn btn-primary"
        >
          Anlegen
        </button>
      </form>
      <p v-if="error" class="mt-2 text-xs text-red-600" data-testid="akten-error">{{ error }}</p>

      <ul class="mt-6 flex flex-col gap-3">
        <li
          v-for="space in list"
          :key="space.id"
          :data-testid="`akte-${space.id}`"
          class="card p-5"
        >
          <div class="flex flex-wrap items-center gap-2">
            <template v-if="renaming === space.id">
              <input
                v-model="renameValue"
                maxlength="128"
                data-testid="akte-rename-input"
                class="field h-9 min-w-0 flex-1"
                @keydown.enter.prevent="onRename(space)"
                @keydown.escape="renaming = null"
              >
              <button type="button" class="text-xs font-medium text-accent" @click="onRename(space)">Speichern</button>
            </template>
            <h2 v-else class="flex min-w-0 flex-1 items-center gap-3 truncate font-serif text-xl font-medium text-ink">
              <span class="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-surface-raised text-ink-muted" aria-hidden="true">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
              </span>
              <span class="truncate">{{ spaceLabel(space) }}</span>
            </h2>
            <span class="rounded-full bg-surface-raised px-2.5 py-0.5 text-[11px] font-medium text-ink-muted" data-testid="akte-role">
              {{ ROLE_LABEL[space.role] }}
            </span>
          </div>
          <p class="mt-2 text-xs text-ink-subtle">
            <template v-if="space.kind === 'shared'">Eigentümer {{ space.owner }} · {{ space.member_count }} Mitglieder · </template>
            <NuxtLink :to="`/library?space=${space.id}`" class="text-accent hover:underline">
              {{ space.document_count }} Dokumente
            </NuxtLink>
          </p>

          <div v-if="space.kind === 'shared'" class="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <button
              type="button"
              data-testid="akte-members-toggle"
              class="font-medium text-ink-muted hover:text-ink"
              @click="openMembers = openMembers === space.id ? null : space.id"
            >
              Mitglieder {{ openMembers === space.id ? "ausblenden" : "anzeigen" }}
            </button>
            <template v-if="space.role === 'owner'">
              <button
                v-if="renaming !== space.id"
                type="button"
                data-testid="akte-rename"
                class="font-medium text-ink-muted hover:text-ink"
                @click="startRename(space)"
              >
                Umbenennen
              </button>
              <button
                type="button"
                data-testid="akte-delete"
                :disabled="space.document_count > 0 || remove.isPending.value"
                :title="space.document_count > 0 ? 'Erst alle Dokumente herausverschieben (auch aus dem Papierkorb)' : ''"
                class="font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-ink-subtle disabled:no-underline"
                @click="onDelete(space)"
              >
                Löschen
              </button>
              <span v-if="space.document_count > 0" class="text-ink-subtle">Löschen geht nur, wenn die Akte leer ist.</span>
            </template>
            <button
              v-else
              type="button"
              data-testid="akte-leave"
              class="font-medium text-red-600 hover:underline"
              @click="onLeave(space)"
            >
              Verlassen
            </button>
          </div>

          <SpacesSpaceMembers v-if="openMembers === space.id" :space="space" class="mt-3" />
        </li>
      </ul>
    </template>
  </div>
</template>
