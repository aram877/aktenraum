<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const { files, send } = useUploadTracker();
const dragging = ref(false);

// Space picker: only for households with a second member; personal space by default.
const { spaces, visible: spacesVisible } = useSpacesVisible();
const targets = computed(() => placeableSpaces(spaces.data.value));
const target = ref<number | null>(null);
const targetId = computed(() => {
  const personal = targets.value.find((s) => s.kind === "personal");
  return target.value ?? personal?.id ?? null;
});
/** Personal = no space_id at all (the api's default), so nothing changes for one member. */
const spaceIdToSend = computed(() => {
  const chosen = targets.value.find((s) => s.id === targetId.value);
  return chosen === undefined || chosen.kind === "personal" ? null : chosen.id;
});

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const dropped = Array.from(event.dataTransfer?.files ?? []);
  if (dropped.length > 0) void send(dropped, spaceIdToSend.value);
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = "";
  if (picked.length > 0) void send(picked, spaceIdToSend.value);
}

function phaseDot(phase: UploadPhase): string {
  if (phase === "error") return "bg-tone-danger";
  if (phase === "inbox" || phase === "library") return "bg-emerald-700";
  return "animate-pulse bg-tone-info";
}

function phaseClass(phase: UploadPhase): string {
  if (phase === "error") return "text-red-700";
  if (phase === "inbox" || phase === "library") return "text-emerald-700";
  return "text-ink-muted";
}
</script>

<template>
  <div class="page-narrow">
    <PageHeader eyebrow="Eingang" title="Hochladen" subtitle="PDF oder Bild hochladen — die KI klassifiziert automatisch." />

    <label v-if="spacesVisible && targets.length > 1" class="mt-8 flex flex-wrap items-center gap-3">
      <span class="label-caps">Ablegen in</span>
      <select
        :value="targetId"
        data-testid="upload-space"
        class="field w-auto min-w-56"
        @change="target = Number(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="space in targets" :key="space.id" :value="space.id">{{ spaceLabel(space) }}</option>
      </select>
    </label>

    <div
      class="mt-6 flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors"
      :class="dragging ? 'border-accent bg-surface' : 'border-hairline bg-surface/60'"
      data-testid="dropzone"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <AppLogo :size="56" />
      <p class="mt-5 font-serif text-2xl font-medium text-ink">Dateien hierher ziehen</p>
      <p class="mt-1 text-sm text-ink-subtle">oder</p>
      <label class="btn btn-primary mt-4 cursor-pointer">
        Dateien auswählen
        <input type="file" multiple class="hidden" data-testid="file-input" @change="onPick">
      </label>
      <p class="mt-4 text-xs text-ink-faint">PDF, PNG, JPG, TIFF · bis 25 MB pro Datei · bis zu 20 Dateien</p>
    </div>

    <ul v-if="files.length > 0" class="card mt-6 divide-y divide-hairline-soft">
      <template v-for="file in files" :key="file.name">
        <li class="flex items-center gap-3 px-4 py-3" :data-testid="`file-${file.name}`">
          <span class="h-2 w-2 flex-none rounded-full" :class="phaseDot(file.phase)" />
          <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ file.name }}</span>
          <span class="shrink-0 text-xs" :class="phaseClass(file.phase)">{{ PHASE_LABEL[file.phase] }}</span>
          <NuxtLink
            v-if="file.docId"
            :to="`/library/${file.docId}`"
            class="shrink-0 text-xs font-medium text-accent hover:text-accent-dark"
          >
            öffnen
          </NuxtLink>
        </li>
        <li v-if="file.detail" class="px-4 pb-3 text-[11px] text-red-700">{{ file.detail }}</li>
      </template>
    </ul>
  </div>
</template>
