<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const { files, send } = useUploadTracker();
const dragging = ref(false);

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const dropped = Array.from(event.dataTransfer?.files ?? []);
  if (dropped.length > 0) void send(dropped);
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = "";
  if (picked.length > 0) void send(picked);
}

function phaseClass(phase: UploadPhase): string {
  if (phase === "error") return "text-red-700";
  if (phase === "inbox" || phase === "library") return "text-emerald-700";
  return "text-ink-muted";
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
    <h1 class="text-lg font-semibold tracking-tight text-ink">Hochladen</h1>
    <p class="mt-0.5 text-xs text-ink-muted">PDF oder Bild hochladen — die KI klassifiziert automatisch.</p>

    <div
      class="mt-5 rounded-xl border-2 border-dashed p-10 text-center"
      :class="dragging ? 'border-accent bg-accent/5' : 'border-hairline'"
      data-testid="dropzone"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <p class="text-sm text-ink-muted">Dateien hierher ziehen</p>
      <p class="mt-1 text-xs text-ink-subtle">oder</p>
      <label
        class="mt-3 inline-block cursor-pointer rounded-lg bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80"
      >
        Dateien auswählen
        <input type="file" multiple class="hidden" data-testid="file-input" @change="onPick">
      </label>
    </div>

    <ul v-if="files.length > 0" class="mt-5 flex flex-col gap-2">
      <template v-for="file in files" :key="file.name">
        <li class="flex items-center gap-3 rounded-lg border border-hairline bg-surface p-3" :data-testid="`file-${file.name}`">
          <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ file.name }}</span>
          <span class="shrink-0 text-xs" :class="phaseClass(file.phase)">{{ PHASE_LABEL[file.phase] }}</span>
          <NuxtLink
            v-if="file.docId"
            :to="`/library/${file.docId}`"
            class="shrink-0 text-xs font-medium text-accent hover:underline"
          >
            öffnen
          </NuxtLink>
        </li>
        <li v-if="file.detail" class="-mt-1 px-3 text-[11px] text-red-700">{{ file.detail }}</li>
      </template>
    </ul>
  </div>
</template>
