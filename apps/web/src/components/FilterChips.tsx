import type { SearchFilter } from "../lib/ai";

type Chip =
  // Single-valued filter fields — clicking the chip clears the whole field.
  | {
      kind: "scalar";
      key: keyof Omit<SearchFilter, "tags">;
      label: string;
      value: string;
    }
  // One per individual tag — clicking removes just that tag from the list.
  | { kind: "tag"; value: string };

type Props = {
  filter: SearchFilter;
  onClearScalar: (key: keyof Omit<SearchFilter, "tags">) => void;
  onClearTag: (tag: string) => void;
  disabled?: boolean;
};

export function FilterChips({
  filter,
  onClearScalar,
  onClearTag,
  disabled,
}: Props) {
  const chips = chipsFromFilter(filter);
  if (chips.length === 0) {
    return (
      <div className="text-xs text-neutral-500">
        Keine Filter — alles wird angezeigt.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c, i) =>
        c.kind === "tag" ? (
          <button
            key={`tag-${c.value}-${i}`}
            type="button"
            onClick={() => onClearTag(c.value)}
            disabled={disabled}
            title="Tag entfernen"
            className="inline-flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs text-emerald-900 hover:bg-emerald-100 disabled:opacity-60"
          >
            <span className="font-medium">Tag:</span>
            <span>{c.value}</span>
            <span aria-hidden className="text-emerald-500">
              ×
            </span>
          </button>
        ) : (
          <button
            key={c.key}
            type="button"
            onClick={() => onClearScalar(c.key)}
            disabled={disabled}
            title="Klick zum Entfernen"
            className="inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-800 hover:bg-neutral-100 disabled:opacity-60"
          >
            <span className="font-medium">{c.label}:</span>
            <span>{c.value}</span>
            <span aria-hidden className="text-neutral-400">
              ×
            </span>
          </button>
        ),
      )}
    </div>
  );
}

function chipsFromFilter(f: SearchFilter): Chip[] {
  const out: Chip[] = [];
  if (f.document_type) {
    out.push({
      kind: "scalar",
      key: "document_type",
      label: "Typ",
      value: f.document_type,
    });
  }
  if (f.correspondent) {
    out.push({
      kind: "scalar",
      key: "correspondent",
      label: "Korrespondent",
      value: f.correspondent,
    });
  }
  if (f.date_from) {
    out.push({ kind: "scalar", key: "date_from", label: "Ab", value: f.date_from });
  }
  if (f.date_to) {
    out.push({ kind: "scalar", key: "date_to", label: "Bis", value: f.date_to });
  }
  if (f.text) {
    out.push({ kind: "scalar", key: "text", label: "Stichwort", value: f.text });
  }
  for (const tag of f.tags ?? []) {
    out.push({ kind: "tag", value: tag });
  }
  return out;
}
