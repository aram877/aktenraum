export const FIELD_TYPE_PLACEHOLDER: Record<string, string> = {
  money: "z. B. 149,99 EUR",
  date: "YYYY-MM-DD",
  month: "YYYY-MM",
  year: "YYYY",
  string: "",
};

export function typeFieldsDraft(
  defs: readonly { name: string }[],
  saved: Record<string, string> | null | undefined,
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const def of defs) draft[def.name] = saved?.[def.name] ?? "";
  return draft;
}

export function typeFieldsChanges(
  draft: Record<string, string>,
  saved: Record<string, string> | null | undefined,
): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(draft)) {
    const next = value.trim();
    const before = saved?.[name] ?? "";
    if (next === before) continue;
    changes[name] = next === "" ? null : next;
  }
  return changes;
}

export function hasTag(tags: readonly string[] | null | undefined, name: string): boolean {
  return (tags ?? []).includes(name);
}
