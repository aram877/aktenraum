<script setup lang="ts">
const query = useAutoApproveRules();
const update = useUpdateAutoApproveRules();

const draft = ref(new Map<string, DraftEntry>());
const showSaved = ref(false);

const rules = computed<readonly AutoApproveRule[]>(() => query.data.value?.rules ?? []);
const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => a.document_type.localeCompare(b.document_type, "de")),
);
const dirty = computed(() => isDraftDirty(rules.value, draft.value));

const errorBanner = computed(() => {
  if (query.isError.value) return detailFrom(query.error.value, "Regeln nicht ladbar.");
  if (update.isError.value) return detailFrom(update.error.value, "Speichern fehlgeschlagen.");
  return null;
});

watch(
  () => query.data.value?.rules,
  (next) => {
    if (next) draft.value = buildDraft(next);
  },
  { immediate: true },
);

function entryFor(documentType: string): DraftEntry {
  return draft.value.get(documentType) ?? { enabled: false, min_confidence: 0.9 };
}

function setEntry(documentType: string, patch: Partial<DraftEntry>): void {
  const next = new Map(draft.value);
  next.set(documentType, { ...entryFor(documentType), ...patch });
  draft.value = next;
}

function setMinConfidence(documentType: string, raw: string): void {
  const parsed = Number.parseFloat(raw || "0");
  setEntry(documentType, { min_confidence: Number.isFinite(parsed) ? parsed : 0 });
}

function toggleAll(enabled: boolean): void {
  const next = new Map(draft.value);
  for (const [key, entry] of next) next.set(key, { ...entry, enabled });
  draft.value = next;
}

function reset(): void {
  draft.value = buildDraft(rules.value);
}

async function onSave(): Promise<void> {
  const payload = rules.value.map((rule) => ({
    document_type: rule.document_type,
    enabled: entryFor(rule.document_type).enabled,
    min_confidence: entryFor(rule.document_type).min_confidence,
  }));
  try {
    await update.mutateAsync(payload);
    showSaved.value = true;
    setTimeout(() => {
      showSaved.value = false;
    }, 3000);
  } catch {
    return;
  }
}
</script>

<template>
  <div>
    <h2 class="text-sm font-semibold text-ink">Auto-Genehmigung</h2>
    <p class="mt-0.5 text-xs text-ink-muted">
      Welche Dokumenttypen dürfen ohne manuelle Prüfung automatisch genehmigt werden? Pro Typ legst
      du Mindest-Konfidenz fest. Änderungen wirken im Auto-Tagger innerhalb von 60&nbsp;Sekunden.
    </p>

    <p
      v-if="showSaved"
      data-testid="auto-approve-saved"
      class="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
    >
      Auto-Genehmigung gespeichert.
    </p>
    <p
      v-if="errorBanner"
      data-testid="auto-approve-error"
      class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {{ errorBanner }}
    </p>

    <p v-if="query.isPending.value" class="mt-4 text-xs text-ink-subtle">Lade Regeln…</p>

    <template v-if="rules.length > 0">
      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
          @click="toggleAll(true)"
        >
          Alle aktivieren
        </button>
        <button
          type="button"
          class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
          @click="toggleAll(false)"
        >
          Alle deaktivieren
        </button>
        <div class="ml-auto flex gap-2">
          <button
            type="button"
            :disabled="!dirty || update.isPending.value"
            class="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
            @click="reset"
          >
            Zurücksetzen
          </button>
          <button
            type="button"
            data-testid="auto-approve-save"
            :disabled="!dirty || update.isPending.value"
            class="rounded-lg bg-ink px-4 py-1.5 text-xs font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-50"
            @click="onSave"
          >
            {{ update.isPending.value ? "speichere…" : "Speichern" }}
          </button>
        </div>
      </div>

      <div class="mt-4 overflow-x-auto rounded-lg border border-hairline">
        <table class="w-full text-sm">
          <thead class="bg-canvas text-left text-xs text-ink-muted">
            <tr>
              <th class="px-3 py-2 font-medium">Typ</th>
              <th class="px-3 py-2 font-medium">Aktiviert</th>
              <th class="px-3 py-2 font-medium">Min. Konfidenz</th>
              <th class="px-3 py-2 font-medium">Zuletzt geändert</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="rule in sortedRules"
              :key="rule.document_type"
              class="border-t border-hairline hover:bg-canvas/50"
            >
              <td class="px-3 py-2 text-ink">{{ rule.document_type }}</td>
              <td class="px-3 py-2">
                <input
                  type="checkbox"
                  :data-testid="`enabled-${rule.document_type}`"
                  :checked="entryFor(rule.document_type).enabled"
                  class="h-4 w-4 accent-ink"
                  @change="setEntry(rule.document_type, { enabled: ($event.target as HTMLInputElement).checked })"
                >
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    :value="entryFor(rule.document_type).min_confidence"
                    class="w-20 rounded-md border border-hairline bg-surface px-2 py-1 text-sm text-ink focus:border-ink focus:outline-none"
                    @input="setMinConfidence(rule.document_type, ($event.target as HTMLInputElement).value)"
                  >
                  <span
                    v-if="rule.min_confidence < LOW_CONFIDENCE_THRESHOLD"
                    title="Min. Konfidenz unter 0,70 — kritische Typen besser höher setzen."
                    class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                  >
                    Achtung: niedriger Schwellwert
                  </span>
                </div>
              </td>
              <td class="px-3 py-2 text-xs text-ink-muted">
                {{ formatTimestamp(rule.updated_at) }}
                <span v-if="rule.updated_by" class="ml-1 text-ink-subtle">({{ rule.updated_by }})</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
