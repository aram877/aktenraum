import { DestroyRef, inject } from "@angular/core";

export type Bindings = Record<string, () => void>;

export function isFormFocused(target: Element | null): boolean {
  if (!target) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return target.getAttribute("contenteditable") === "true";
}

export function shouldHandle(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">,
  activeElement: Element | null,
): boolean {
  if (isFormFocused(activeElement)) return false;
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

export function registerShortcuts(bindings: () => Bindings, enabled: () => boolean): void {
  const destroyRef = inject(DestroyRef);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!enabled()) return;
    if (!shouldHandle(event, document.activeElement)) return;
    const handler = bindings()[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };
  window.addEventListener("keydown", onKeyDown);
  destroyRef.onDestroy(() => window.removeEventListener("keydown", onKeyDown));
}
