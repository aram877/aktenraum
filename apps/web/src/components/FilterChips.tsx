import type { SearchFilter } from "../lib/ai";

type ChipKey = keyof SearchFilter;

type Props = {
  filter: SearchFilter;
  onClear: (key: ChipKey) => void;
  disabled?: boolean;
};

export function FilterChips({ filter, onClear, disabled }: Props) {
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
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onClear(c.key)}
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
      ))}
    </div>
  );
}

function chipsFromFilter(
  f: SearchFilter,
): { key: ChipKey; label: string; value: string }[] {
  const out: { key: ChipKey; label: string; value: string }[] = [];
  if (f.document_type) {
    out.push({ key: "document_type", label: "Typ", value: f.document_type });
  }
  if (f.correspondent) {
    out.push({ key: "correspondent", label: "Korrespondent", value: f.correspondent });
  }
  if (f.date_from) {
    out.push({ key: "date_from", label: "Ab", value: f.date_from });
  }
  if (f.date_to) {
    out.push({ key: "date_to", label: "Bis", value: f.date_to });
  }
  if (f.min_amount != null) {
    out.push({ key: "min_amount", label: "Min", value: `${f.min_amount}€` });
  }
  if (f.max_amount != null) {
    out.push({ key: "max_amount", label: "Max", value: `${f.max_amount}€` });
  }
  if (f.text) {
    out.push({ key: "text", label: "Stichwort", value: f.text });
  }
  return out;
}
