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
