<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const route = useRoute();
const question = ref("");
const { answer, meta, citations, errorText, streaming, ask, stop } = useAnswerStream();
const canSubmit = computed(() => question.value.trim().length > 0 && !streaming.value);

const SUGGESTIONS = [
  "Was hat die Stromrechnung im März gekostet?",
  "Wann läuft mein Mietvertrag aus?",
  "Wie hoch war mein Nettogehalt im Oktober?",
  "Welche Versicherungen habe ich?",
] as const;

function submit(text: string = question.value): void {
  const q = text.trim();
  if (!q || streaming.value) return;
  question.value = q;
  ask(q);
}

// The home page's question box hands over with ?q=.
onMounted(() => {
  const q = firstParam(route.query.q).trim();
  if (q) submit(q);
});
</script>

<template>
  <div class="page-narrow">
    <PageHeader eyebrow="KI-Assistent" title="Fragen" subtitle="Stelle Fragen zu deinen Dokumenten in natürlicher Sprache." />

    <form class="mt-8 flex flex-wrap gap-2" @submit.prevent="submit()">
      <label class="flex h-12 min-w-0 flex-[1_1_320px] items-center gap-3 rounded-xl border border-hairline bg-surface px-4 text-ink-subtle focus-within:border-ink-faint">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <span class="sr-only">Frage</span>
        <input
          v-model="question"
          type="text"
          name="question"
          placeholder="z.B. Was hat die Stromrechnung im März gekostet?"
          class="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
        >
      </label>
      <button
        v-if="streaming"
        type="button"
        data-testid="ask-stop"
        class="btn btn-secondary h-12 px-6"
        @click="stop"
      >
        Stopp
      </button>
      <button
        v-else
        type="submit"
        :disabled="!canSubmit"
        data-testid="ask-submit"
        class="btn btn-primary h-12 px-6"
      >
        Fragen
      </button>
    </form>

    <div v-if="!answer && !streaming && !errorText" class="mt-4 flex flex-wrap gap-2" data-testid="ask-suggestions">
      <button
        v-for="s in SUGGESTIONS"
        :key="s"
        type="button"
        class="rounded-full border border-hairline bg-surface px-3.5 py-1.5 text-[13px] text-ink-muted hover:border-ink-faint hover:text-ink"
        @click="submit(s)"
      >
        {{ s }}
      </button>
    </div>

    <p
      v-if="errorText"
      data-testid="ask-error"
      class="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {{ errorText }}
    </p>

    <p v-if="meta" class="mt-8 text-xs text-ink-subtle" data-testid="ask-meta">
      {{ meta.explanation }} · {{ meta.total }} Treffer
    </p>

    <article
      v-if="answer"
      class="card mt-3 p-6 sm:p-8"
      data-testid="ask-answer"
    >
      <p class="label-caps mb-3">Antwort</p>
      <div class="whitespace-pre-wrap font-serif text-lg leading-relaxed text-ink">{{ answer }}<span v-if="streaming" class="animate-pulse">▍</span></div>
    </article>

    <section v-if="citations.length > 0" class="mt-8" aria-labelledby="ask-sources">
      <div class="flex items-baseline gap-3 border-b border-hairline px-1 pb-2.5">
        <h2 id="ask-sources" class="font-serif text-xl font-medium text-ink">Quellen</h2>
        <span class="text-xs text-ink-subtle">{{ citations.length }}</span>
      </div>
      <ul class="divide-y divide-hairline-soft">
        <li v-for="doc in citations" :key="doc.id" data-testid="ask-citation">
          <NuxtLink
            :to="`/library/${doc.id}`"
            class="flex items-center gap-4 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-surface/70"
          >
            <DocTypeTile :type="doc.document_type" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium text-ink">{{ doc.title }}</span>
              <span class="mt-0.5 block truncate text-xs text-ink-subtle">
                <span class="font-medium" :style="{ color: docTypeStyle(doc.document_type).family.ink }">{{ docTypeStyle(doc.document_type).name }}</span>
                <template v-if="doc.correspondent"> · {{ doc.correspondent }}</template>
              </span>
            </span>
            <span class="tabular text-xs text-ink-subtle">{{ formatDocDate(doc.created) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>
