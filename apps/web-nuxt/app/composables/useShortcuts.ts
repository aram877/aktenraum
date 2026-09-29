import type { MaybeRefOrGetter } from "vue";

export type Bindings = Record<string, () => void>;

export function useShortcuts(bindings: () => Bindings, enabled: MaybeRefOrGetter<boolean>): void {
  function onKeyDown(event: KeyboardEvent): void {
    if (!toValue(enabled)) return;
    if (!shouldHandle(event, document.activeElement)) return;
    const handler = bindings()[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  }
  onMounted(() => window.addEventListener("keydown", onKeyDown));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeyDown));
}
