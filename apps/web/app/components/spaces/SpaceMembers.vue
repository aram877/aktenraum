<script setup lang="ts">
import type { MemberRole, SpaceSummary } from "~/composables/useSpaces";

/** Members of one shared space: the owner manages them, everyone else only sees them. */
const props = defineProps<{ space: SpaceSummary }>();

const isOwner = computed(() => props.space.role === "owner");
const members = useSpaceMembers(() => props.space.id);
const directory = useHouseholdDirectory(isOwner);
const add = useAddSpaceMember();
const changeRole = useChangeSpaceRole();
const remove = useRemoveSpaceMember();

const ROLE_LABEL: Record<string, string> = { owner: "Eigentümer", editor: "Bearbeiten", viewer: "Nur lesen" };

const candidates = computed(() => {
  const inSpace = new Set((members.data.value ?? []).map((m) => m.member_id));
  return (directory.data.value ?? []).filter((d) => !inSpace.has(d.id));
});

const newMember = ref<number | null>(null);
const newRole = ref<MemberRole>("editor");
const error = ref<string | null>(null);

async function run(work: () => Promise<unknown>, fallback: string): Promise<void> {
  error.value = null;
  try {
    await work();
  } catch (e: unknown) {
    error.value = detailFrom(e, fallback);
  }
}

function onAdd(): Promise<void> {
  const memberId = newMember.value;
  if (memberId === null) return Promise.resolve();
  return run(async () => {
    await add.mutateAsync({ spaceId: props.space.id, memberId, role: newRole.value });
    newMember.value = null;
  }, "Mitglied konnte nicht hinzugefügt werden.");
}

function onRole(memberId: number, event: Event): Promise<void> {
  const role = (event.target as HTMLSelectElement).value as MemberRole;
  return run(
    () => changeRole.mutateAsync({ spaceId: props.space.id, memberId, role }),
    "Rolle konnte nicht geändert werden.",
  );
}

function onRemove(memberId: number): Promise<void> {
  return run(
    () => remove.mutateAsync({ spaceId: props.space.id, memberId }),
    "Mitglied konnte nicht entfernt werden.",
  );
}
</script>

<template>
  <div :data-testid="`space-members-${space.id}`">
    <ul class="divide-y divide-hairline rounded-lg border border-hairline">
      <li
        v-for="member in members.data.value ?? []"
        :key="member.member_id"
        data-testid="space-member-row"
        class="flex items-center gap-3 px-3 py-2 text-sm"
      >
        <span class="min-w-0 flex-1 truncate font-medium text-ink">{{ member.username }}</span>
        <template v-if="isOwner && member.role !== 'owner'">
          <select
            :value="member.role"
            data-testid="space-member-role"
            class="rounded border border-hairline bg-surface px-2 py-1 text-xs"
            @change="onRole(member.member_id, $event)"
          >
            <option value="editor">Bearbeiten</option>
            <option value="viewer">Nur lesen</option>
          </select>
          <button
            type="button"
            data-testid="space-member-remove"
            class="text-xs text-red-600 hover:underline"
            @click="onRemove(member.member_id)"
          >
            Entfernen
          </button>
        </template>
        <span v-else class="text-xs text-ink-subtle">{{ ROLE_LABEL[member.role] }}</span>
      </li>
      <li v-if="members.isPending.value" class="px-3 py-2 text-xs text-ink-subtle">Lädt…</li>
    </ul>

    <form
      v-if="isOwner && candidates.length > 0"
      class="mt-3 flex flex-wrap items-center gap-2"
      data-testid="space-member-add"
      @submit.prevent="onAdd"
    >
      <select
        v-model="newMember"
        data-testid="space-member-pick"
        class="rounded border border-hairline bg-surface px-2 py-1.5 text-xs"
      >
        <option :value="null" disabled>Mitglied wählen…</option>
        <option v-for="c in candidates" :key="c.id" :value="c.id">{{ c.username }}</option>
      </select>
      <select v-model="newRole" class="rounded border border-hairline bg-surface px-2 py-1.5 text-xs">
        <option value="editor">Bearbeiten</option>
        <option value="viewer">Nur lesen</option>
      </select>
      <button
        type="submit"
        :disabled="newMember === null || add.isPending.value"
        class="btn btn-primary btn-sm"
      >
        Hinzufügen
      </button>
    </form>
    <p v-if="error" class="mt-2 text-xs text-red-600" data-testid="space-members-error">{{ error }}</p>
  </div>
</template>
