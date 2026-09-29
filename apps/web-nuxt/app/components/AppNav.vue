<script setup lang="ts">
const route = useRoute();
const me = useMe();
const authenticated = computed(() => Boolean(me.data.value));

const inFlight = useInFlightCount(authenticated);
const trash = useTrashList(authenticated);
const inbox = useInboxList({ pageSize: 1 }, authenticated);
const live = useLiveCounts();
const logout = useLogout();

const inboxCount = computed(() => live.data.value?.inbox ?? inbox.data.value?.total ?? 0);
const trashCount = computed(() => live.data.value?.trash ?? trash.data.value?.total ?? 0);
const inFlightCount = computed(() =>
  Math.max(0, (live.data.value?.in_flight ?? inFlight.data.value?.count ?? 0) - inboxCount.value),
);

const menuOpen = ref(false);

const links = [
  { to: "/", label: "Start", exact: true },
  { to: "/ask", label: "Ask AI", exact: false },
  { to: "/library", label: "Bibliothek", exact: false },
  { to: "/upload", label: "Hochladen", exact: false },
  { to: "/trash", label: "Papierkorb", exact: false },
  { to: "/settings", label: "Einstellungen", exact: false },
];

function isActive(link: { to: string; exact: boolean }): boolean {
  if (link.exact) return route.path === link.to;
  return route.path === link.to || route.path.startsWith(`${link.to}/`);
}

function closeMenu(): void {
  menuOpen.value = false;
}

async function onLogout(): Promise<void> {
  closeMenu();
  await logout.mutateAsync().catch(() => undefined);
  await navigateTo("/login");
}
</script>

<template>
  <nav v-if="authenticated" class="border-b border-hairline bg-surface px-4 py-2.5 sm:px-6">
    <div class="mx-auto flex max-w-6xl items-center gap-4 text-sm">
      <NuxtLink to="/" class="font-semibold tracking-tight text-ink" @click="closeMenu">
        aktenraum
      </NuxtLink>

      <div class="hidden items-center gap-4 md:flex">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="text-ink-muted hover:text-ink"
          :class="{ 'font-medium text-ink': isActive(link) }"
        >
          {{ link.label }}
          <span
            v-if="link.to === '/library' && inboxCount > 0"
            data-testid="review-badge"
            title="Dokumente zur Prüfung"
            class="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
          >
            {{ inboxCount }}
          </span>
          <span
            v-if="link.to === '/trash' && trashCount > 0"
            class="ml-1 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-ink-subtle"
          >
            {{ trashCount }}
          </span>
        </NuxtLink>
      </div>

      <div class="ml-auto flex items-center gap-3">
        <span
          v-if="inFlightCount > 0"
          data-testid="in-flight-pill"
          class="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent"
        >
          {{ inFlightCount }} in Bearbeitung
        </span>
        <button
          type="button"
          class="hidden text-xs text-ink-muted hover:text-ink md:inline"
          @click="onLogout"
        >
          Abmelden
        </button>
        <button
          type="button"
          data-testid="nav-menu-toggle"
          :aria-expanded="menuOpen"
          aria-label="Menü"
          class="flex h-10 w-10 items-center justify-center rounded-lg border border-hairline text-ink md:hidden"
          @click="menuOpen = !menuOpen"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path v-if="menuOpen" d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            <path v-else d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div
      v-if="menuOpen"
      class="mt-2 flex flex-col gap-1 border-t border-hairline pt-2 md:hidden"
      data-testid="nav-drawer"
    >
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        class="flex min-h-11 items-center rounded-lg px-3 text-sm text-ink-muted hover:bg-canvas"
        :class="{ 'bg-canvas font-medium text-ink': isActive(link) }"
        @click="closeMenu"
      >
        {{ link.label }}
        <span
          v-if="link.to === '/library' && inboxCount > 0"
          data-testid="review-badge-drawer"
          class="ml-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
        >
          {{ inboxCount }}
        </span>
        <span
          v-if="link.to === '/trash' && trashCount > 0"
          class="ml-2 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-ink-subtle"
        >
          {{ trashCount }}
        </span>
      </NuxtLink>
      <button
        type="button"
        class="flex min-h-11 items-center rounded-lg px-3 text-left text-sm text-ink-muted hover:bg-canvas"
        @click="onLogout"
      >
        Abmelden
      </button>
    </div>
  </nav>
</template>
