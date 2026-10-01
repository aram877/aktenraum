<script setup lang="ts">
definePageMeta({ layout: "bare" });

interface HealthResponse {
  status: string;
}

const { data, status, error } = useFetch<HealthResponse>("/api/health", { key: "health" });
</script>

<template>
  <p v-if="status === 'idle' || status === 'pending'" data-testid="state">Lädt…</p>
  <p v-else-if="status === 'error'" data-testid="state">Fehler: {{ error?.message }}</p>
  <p v-else data-testid="state">API-Status: {{ data?.status }}</p>
</template>
