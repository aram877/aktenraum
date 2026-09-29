<script setup lang="ts">
definePageMeta({ middleware: "auth" });

const question = ref("");
const { answer, meta, citations, errorText, streaming, ask, stop } = useAnswerStream();
const canSubmit = computed(() => question.value.trim().length > 0 && !streaming.value);
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
    <h1 class="text-lg font-semibold tracking-tight text-ink">Ask AI</h1>
    <p class="mt-0.5 text-xs text-ink-muted">Stelle Fragen zu deinen Dokumenten in natürlicher Sprache.</p>

    <form class="mt-4 flex gap-2" @submit.prevent="ask(question)">
      <input
        v-model="question"
        type="text"
        name="question"
        placeholder="z.B. Was hat die Stromrechnung im März gekostet?"
        class="flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
      >
      <button
        v-if="streaming"
        type="button"
        data-testid="ask-stop"
        class="rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-ink hover:bg-canvas"
        @click="stop"
      >
        Stopp
      </button>
      <button
        v-else
        type="submit"
        :disabled="!canSubmit"
        data-testid="ask-submit"
        class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-surface disabled:opacity-50"
      >
        Fragen
      </button>
    </form>

    <p
      v-if="errorText"
      data-testid="ask-error"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {{ errorText }}
    </p>

    <p v-if="meta" class="mt-4 text-xs text-ink-subtle" data-testid="ask-meta">
      {{ meta.explanation }} · {{ meta.total }} Treffer
    </p>

    <div
      v-if="answer"
      class="mt-3 whitespace-pre-wrap rounded-lg border border-hairline bg-surface p-4 text-sm text-ink"
      data-testid="ask-answer"
    >{{ answer }}<span v-if="streaming" class="animate-pulse">▍</span></div>

    <div v-if="citations.length > 0" class="mt-4">
      <p class="text-xs font-medium text-ink-muted">Quellen</p>
      <ul class="mt-2 flex flex-col gap-2">
        <li v-for="doc in citations" :key="doc.id" class="rounded-lg border border-hairline bg-surface p-3">
          <NuxtLink :to="`/library/${doc.id}`" class="text-sm font-medium text-ink hover:text-accent">{{ doc.title }}</NuxtLink>
          <p class="mt-0.5 text-xs text-ink-muted">
            {{ doc.document_type ?? "—" }} · {{ doc.correspondent ?? "—" }} · {{ doc.created ?? "—" }}
          </p>
        </li>
      </ul>
    </div>
  </div>
</template>
