import { useEffect } from "react";

type Bindings = Record<string, () => void>;

function isFormFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.getAttribute("contenteditable") === "true";
}

export function useKeyboardShortcuts(bindings: Bindings, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFormFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const handler = bindings[e.key];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, enabled]);
}
