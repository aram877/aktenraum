<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const RANGES = [
  { days: 1, label: "24 h" },
  { days: 7, label: "7 Tage" },
  { days: 30, label: "30 Tage" },
] as const;

const OUTCOME_FILTERS: { value: IngestOutcome | ""; label: string }[] = [
  { value: "", label: "Alle" },
  { value: "new", label: "Neu" },
  { value: "duplicate", label: "Duplikate" },
  { value: "failed", label: "Fehler" },
  { value: "running", label: "Läuft" },
];

const OUTCOME_STYLE: Record<IngestOutcome, string> = {
  new: "bg-emerald-500/10 text-emerald-700",
  duplicate: "bg-surface-raised text-ink-muted",
  failed: "bg-red-500/10 text-red-700",
  running: "bg-accent/10 text-accent",
};

const route = useRoute();

const days = computed(() => {
  const parsed = Number.parseInt(firstParam(route.query.days), 10);
  return RANGES.some((r) => r.days === parsed) ? parsed : 7;
});

const activity = useIngestActivity(days);
const outcomeFilter = ref<IngestOutcome | "">("");

const data = computed(() => activity.data.value ?? null);
const items = computed<readonly IngestItem[]>(() => {
  const all = data.value?.items ?? [];
  return outcomeFilter.value === "" ? all : all.filter((i) => i.outcome === outcomeFilter.value);
});
const errorText = computed(() =>
  activity.isError.value ? detailFrom(activity.error.value, "Aktivität konnte nicht geladen werden.") : null,
);
const settled = computed(() => activitySettled(data.value));

function setDays(next: number): void {
  void navigateTo({ path: "/activity", query: next === 7 ? {} : { days: String(next) } });
}
</script>

<template>
  <div class="page">
    <div>
      <div>
        <PageHeader
          eyebrow="Eingang"
          title="Aktivität"
          subtitle="Was Paperless importiert hat – per E-Mail, Upload oder Ordner – und was daraus wurde."
        >
          <template #actions>
            <div class="inline-flex rounded-xl bg-surface-sunken p-1" role="group" aria-label="Zeitraum">
              <button
                v-for="range in RANGES"
                :key="range.days"
                type="button"
                :data-testid="`range-${range.days}`"
                class="h-9 rounded-[9px] px-4 text-sm font-medium"
                :class="days === range.days ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(28,25,23,0.08)]' : 'text-ink-muted hover:text-ink'"
                @click="setDays(range.days)"
              >
                {{ range.label }}
              </button>
            </div>
          </template>
        </PageHeader>

        <p v-if="errorText" class="mt-8 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ errorText }}
        </p>
        <p v-else-if="activity.isPending.value" class="mt-6 text-xs text-ink-subtle">Lade Aktivität…</p>

        <template v-else-if="data">
          <div class="mt-8 flex flex-wrap items-center gap-2 text-xs" data-testid="activity-summary">
            <span class="rounded-full bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-700">{{ data.summary.new }} neu</span>
            <span class="rounded-full bg-surface-raised px-2.5 py-1 font-medium text-ink-muted">{{ data.summary.duplicate }} Duplikate</span>
            <span
              class="rounded-full px-2.5 py-1 font-medium"
              :class="data.summary.failed > 0 ? 'bg-red-500/10 text-red-700' : 'bg-surface-raised text-ink-muted'"
            >{{ data.summary.failed }} Fehler</span>
            <span v-if="data.summary.running > 0" class="rounded-full bg-accent/10 px-2.5 py-1 font-medium text-accent">{{ data.summary.running }} laufen</span>
            <span class="text-ink-subtle">
              · {{ data.summary.by_source.email }} E-Mail · {{ data.summary.by_source.upload }} Upload · {{ data.summary.by_source.folder }} Ordner
            </span>
            <span v-if="!settled" class="text-ink-subtle" data-testid="activity-live">· aktualisiert sich automatisch</span>
          </div>
          <p v-if="data.truncated" class="mt-2 text-xs text-ink-subtle">
            Nur die neuesten {{ data.items.length }} Importe werden angezeigt.
          </p>

          <section v-if="data.mails.length" class="mt-10">
            <h2 class="border-b border-hairline px-1 pb-2.5 font-serif text-xl font-medium text-ink">E-Mails</h2>
            <ul class="mt-3 flex flex-col gap-2">
              <li
                v-for="mail in data.mails"
                :key="mail.id"
                class="card px-4 py-3"
                data-testid="activity-mail"
              >
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <span class="text-sm font-medium text-ink">{{ mail.subject ?? "(ohne Betreff)" }}</span>
                  <span class="text-xs text-ink-subtle">
                    empfangen {{ formatDateTime(mail.received) }} · verarbeitet {{ formatDateTime(mail.processed) }}
                  </span>
                </div>
                <p class="mt-1 text-xs" :class="mail.status === 'FAILED' ? 'text-amber-700' : 'text-ink-muted'">
                  {{ MAIL_STATUS_LABEL[mail.status] ?? mail.status }}
                  <template v-if="mail.status === 'FAILED'">
                    – mindestens ein Anhang wurde nicht importiert (oft nur ein Duplikat, siehe unten).
                  </template>
                </p>
                <p v-if="mail.error_summary" class="mt-1 break-words font-mono text-[11px] text-ink-subtle">
                  {{ mail.error_summary }}
                </p>
              </li>
            </ul>
          </section>

          <section class="mt-10">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-1 pb-2.5">
              <h2 class="font-serif text-xl font-medium text-ink">Importierte Dateien</h2>
              <div class="flex flex-wrap gap-1">
                <button
                  v-for="f in OUTCOME_FILTERS"
                  :key="f.value"
                  type="button"
                  :data-testid="`outcome-${f.value || 'all'}`"
                  class="rounded-full border px-2.5 py-1 text-[11px] font-medium"
                  :class="outcomeFilter === f.value ? 'border-accent text-accent' : 'border-hairline text-ink-muted'"
                  @click="outcomeFilter = f.value"
                >
                  {{ f.label }}
                </button>
              </div>
            </div>

            <p
              v-if="items.length === 0"
              class="py-12 text-center font-serif text-lg text-ink-subtle"
              data-testid="activity-empty"
            >
              Keine Importe im gewählten Zeitraum.
            </p>
            <ul v-else class="flex flex-col divide-y divide-hairline-soft">
              <li
                v-for="item in items"
                :key="item.task_id"
                class="flex flex-col gap-1 rounded-[10px] px-2 py-3 transition-colors hover:bg-surface/70 md:flex-row md:items-center md:gap-4"
                data-testid="activity-item"
              >
                <div class="flex shrink-0 items-center gap-2 md:w-48">
                  <span
                    class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    :class="OUTCOME_STYLE[item.outcome]"
                  >{{ OUTCOME_LABEL[item.outcome] }}</span>
                  <span class="text-[11px] text-ink-subtle">{{ SOURCE_LABEL[item.source] }} · {{ formatDateTime(item.created) }}</span>
                </div>
                <span class="min-w-0 truncate text-xs text-ink-muted md:w-64" :title="item.file_name ?? ''">
                  {{ item.file_name ?? "—" }}
                </span>
                <div class="min-w-0 flex-1 text-sm">
                  <template v-if="item.outcome === 'new' && item.document">
                    <span class="flex flex-wrap items-center gap-2">
                      <NuxtLink v-if="!item.document.missing" :to="`/library/${item.document.id}`" class="text-ink hover:text-accent">
                        {{ item.document.title ?? `Dokument #${item.document.id}` }}
                      </NuxtLink>
                      <span v-else class="text-ink-subtle">#{{ item.document.id }} (nicht mehr vorhanden)</span>
                      <ProcessingBadge v-if="!item.document.missing" :tags="item.document.lifecycle_tags" />
                    </span>
                  </template>
                  <template v-else-if="item.outcome === 'duplicate' && item.duplicate_of">
                    <span class="text-ink-muted">Bereits vorhanden: </span>
                    <NuxtLink
                      v-if="!item.duplicate_of.missing"
                      :to="`/library/${item.duplicate_of.id}`"
                      class="text-ink hover:text-accent"
                      data-testid="duplicate-link"
                    >
                      #{{ item.duplicate_of.id }} · {{ item.duplicate_of.title ?? "ohne Titel" }}
                    </NuxtLink>
                    <span v-else class="text-ink-subtle">
                      #{{ item.duplicate_of.id }} {{ item.duplicate_of.title ?? "" }} (im Papierkorb oder gelöscht)
                    </span>
                  </template>
                  <span v-else-if="item.outcome === 'failed'" class="break-words text-xs text-red-700">
                    {{ item.message ?? "Unbekannter Fehler" }}
                  </span>
                  <span v-else-if="item.outcome === 'running'" class="text-xs text-ink-subtle">
                    Paperless verarbeitet die Datei…
                  </span>
                </div>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>
