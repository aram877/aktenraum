<script setup lang="ts">
defineProps<{ confidence: number | null; confidenceReason: string | null }>();

const form = defineModel<FormState>({ required: true });

const TEXT_FIELDS: { field: FormField; label: string; placeholder?: string }[] = [
  { field: "ai_correspondent", label: "Korrespondent" },
  { field: "ai_title", label: "Titel" },
  { field: "ai_issue_date", label: "Dokumentdatum", placeholder: "YYYY-MM-DD" },
  { field: "ai_reference_numbers", label: "Referenznummern" },
  { field: "ai_suggested_tags", label: "Vorgeschlagene Tags" },
];

function setField(field: FormField, value: string): void {
  form.value = { ...form.value, [field]: value };
}

function valueOf(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
</script>

<template>
  <label class="block text-xs font-medium text-ink-muted">
    Dokumenttyp
    <select
      name="ai_document_type"
      :value="form.ai_document_type"
      class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
      @change="setField('ai_document_type', valueOf($event))"
    >
      <option value="">—</option>
      <option v-for="dt in DOC_TYPES" :key="dt" :value="dt">{{ dt }}</option>
    </select>
  </label>

  <label v-for="item in TEXT_FIELDS" :key="item.field" class="block text-xs font-medium text-ink-muted">
    {{ item.label }}
    <input
      type="text"
      :name="item.field"
      :placeholder="item.placeholder"
      :value="form[item.field]"
      class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
      @input="setField(item.field, valueOf($event))"
    >
  </label>

  <label class="block text-xs font-medium text-ink-muted">
    Zusammenfassung
    <textarea
      name="ai_summary_de"
      rows="4"
      :value="form.ai_summary_de"
      class="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
      @input="setField('ai_summary_de', valueOf($event))"
    />
  </label>

  <p class="text-[11px] text-ink-subtle">
    Konfidenz: {{ confidence !== null ? `${(confidence * 100).toFixed(0)} %` : "—" }}
    <template v-if="confidenceReason"> · {{ confidenceReason }}</template>
  </p>
</template>
