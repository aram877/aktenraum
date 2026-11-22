// Shared colour-mode state (dark-mode change). The preference is kept per
// device in localStorage; every access is guarded because storage can be
// blocked (private windows, site data off) — then the app uses System and the
// toggle still works for the current visit.

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStored(): ColorMode {
  try {
    return parseColorMode(globalThis.localStorage?.getItem(COLOR_MODE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function writeStored(mode: ColorMode): void {
  try {
    if (mode === "system") globalThis.localStorage?.removeItem(COLOR_MODE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(COLOR_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage unavailable: keep the choice in memory only.
  }
}

function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** Puts the resolved mode on <html> (`dark` / `light` class + `color-scheme`). */
export function applyColorMode(resolved: ResolvedColorMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
}

export function useColorMode() {
  const mode = useState<ColorMode>("color-mode", () => readStored());
  const systemDark = useState<boolean>("color-mode-system-dark", () => systemPrefersDark());
  const resolved = computed<ResolvedColorMode>(() => resolveColorMode(mode.value, systemDark.value));

  function set(next: ColorMode): void {
    mode.value = next;
    writeStored(next);
    applyColorMode(resolveColorMode(next, systemDark.value));
  }

  function cycle(): void {
    set(nextColorMode(mode.value));
  }

  return { mode, resolved, systemDark, set, cycle, label: computed(() => colorModeLabel(mode.value)) };
}

/** Called once by the client plugin: apply now and follow the device setting. */
export function startColorMode(): () => void {
  const { mode, systemDark } = useColorMode();
  applyColorMode(resolveColorMode(mode.value, systemDark.value));
  let media: MediaQueryList | null = null;
  try {
    media = globalThis.matchMedia?.(DARK_QUERY) ?? null;
  } catch {
    media = null;
  }
  const onChange = (event: MediaQueryListEvent): void => {
    systemDark.value = event.matches;
    applyColorMode(resolveColorMode(mode.value, event.matches));
  };
  media?.addEventListener?.("change", onChange);
  return () => media?.removeEventListener?.("change", onChange);
}
