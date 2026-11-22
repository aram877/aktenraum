<script setup lang="ts">
const route = useRoute();
const me = useMe();
const authenticated = computed(() => Boolean(me.data.value));

const inFlight = useInFlightCount(authenticated);
const trash = useTrashList(authenticated);
const inbox = useInboxList({ pageSize: 1 }, authenticated);
const errorList = useErrorCount(authenticated);
const live = useLiveCounts();
const logout = useLogout();
const colorMode = useColorMode();

// Sun = Hell, moon = Dunkel, half-filled circle = System (follows the device).
const COLOR_MODE_ICON: Record<ColorMode, string> = {
  light:
    "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 100 10 5 5 0 000-10z",
  dark: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  system: "M12 3a9 9 0 100 18V3zM12 3a9 9 0 010 18",
};

const inboxCount = computed(() => live.data.value?.inbox ?? inbox.data.value?.total ?? 0);
const trashCount = computed(() => live.data.value?.trash ?? trash.data.value?.total ?? 0);
const inFlightCount = computed(() =>
  Math.max(0, (live.data.value?.in_flight ?? inFlight.data.value?.count ?? 0) - inboxCount.value),
);

const errorCount = computed(() => live.data.value?.errors ?? errorList.data.value?.total ?? 0);

const backup = useBackupStatus(authenticated);
const backupAlert = computed(() => backupNotice(backup.data.value));

const menuOpen = ref(false);

// "Akten" only once the household has a second member (ADR-009).
const { visible: spacesVisible } = useSpacesVisible(authenticated);

const links = computed(() => [
  { to: "/", label: "Start", exact: true },
  { to: "/ask", label: "Ask AI", exact: false },
  { to: "/library", label: "Bibliothek", exact: false },
  ...(spacesVisible.value
    ? [
        { to: "/akten", label: "Akten", exact: false },
        { to: "/geteilt", label: "Geteilt", exact: false },
      ]
    : []),
  { to: "/upload", label: "Hochladen", exact: false },
  { to: "/activity", label: "Aktivität", exact: false },
  { to: "/trash", label: "Papierkorb", exact: false },
  { to: "/settings", label: "Einstellungen", exact: false },
]);

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
  <nav v-if="authenticated" class="border-b border-hairline bg-canvas px-4 sm:px-8">
    <div class="mx-auto flex h-16 max-w-[1360px] items-center gap-6 text-sm lg:gap-8">
      <NuxtLink to="/" class="text-2xl" aria-label="aktenraum – Start" @click="closeMenu">
        <AppLogo :size="30" wordmark />
      </NuxtLink>

      <div class="hidden h-full items-center gap-5 text-[13px] font-medium md:flex lg:gap-6">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="flex h-full items-center border-b-2 pt-0.5 text-ink-subtle hover:text-ink"
          :class="isActive(link) ? 'border-ink text-ink' : 'border-transparent'"
        >
          {{ link.label }}
          <span
            v-if="link.to === '/library' && inboxCount > 0"
            data-testid="review-badge"
            title="Dokumente zur Prüfung"
            class="ml-1.5 rounded-full bg-tone-warning px-1.5 py-px text-[10px] font-semibold text-canvas"
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
        <NuxtLink
          v-if="errorCount > 0"
          to="/library?status=error"
          data-testid="error-pill"
          title="Dokumente mit Verarbeitungsfehler"
          class="rounded-full bg-red-500/10 px-2.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-500/20"
          @click="closeMenu"
        >
          {{ errorCount }} Fehler
        </NuxtLink>
        <NuxtLink
          v-if="backupAlert.pill"
          to="/settings#backup"
          data-testid="backup-pill"
          :title="backupAlert.summary"
          class="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
          :class="
            backupAlert.tone === 'error'
              ? 'bg-red-500/10 text-red-600 hover:bg-red-500/20'
              : 'bg-amber-500/15 text-amber-700 hover:bg-amber-500/25'
          "
          @click="closeMenu"
        >
          {{ backupAlert.pill }}
        </NuxtLink>
        <span
          v-if="inFlightCount > 0"
          data-testid="in-flight-pill"
          class="hidden items-center gap-1.5 text-xs text-ink-muted sm:inline-flex"
        >
          <span class="h-[7px] w-[7px] animate-pulse rounded-full bg-tone-info" />
          {{ inFlightCount }} in Bearbeitung
        </span>
        <button
          type="button"
          data-testid="color-mode-toggle"
          :aria-label="`Darstellung: ${colorMode.label.value} – umschalten`"
          :title="`Darstellung: ${colorMode.label.value}`"
          class="hidden h-9 w-9 items-center justify-center rounded-[9px] text-ink-muted hover:bg-surface-raised hover:text-ink md:flex"
          @click="colorMode.cycle"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="COLOR_MODE_ICON[colorMode.mode.value]" />
          </svg>
        </button>
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
        data-testid="color-mode-toggle-drawer"
        class="flex min-h-11 items-center gap-2 rounded-lg px-3 text-left text-sm text-ink-muted hover:bg-surface-raised"
        @click="colorMode.cycle"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="COLOR_MODE_ICON[colorMode.mode.value]" />
        </svg>
        Darstellung: {{ colorMode.label.value }}
      </button>
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
