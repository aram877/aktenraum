/**
 * Status pill rendered next to a document anywhere it appears (Library rows,
 * Find / Ask result cards, soon the Upload page). The pill maps a list of
 * lifecycle tag names from the backend onto a single, human-readable state.
 *
 * Precedence (top wins so the most actionable state surfaces):
 *   ai-error / ai-propagation-error → "Fehler"
 *   ai-rejected                     → "Abgelehnt"
 *   ai-pending                      → "In Inbox"
 *   ai-approved                     → "Wird übertragen"
 *   ai-propagated                   → "Verarbeitet"
 *   ai-low-confidence (alone)       → "Niedrige Konfidenz"
 *   (no lifecycle tag)              → "Wartet auf KI"
 */

type Variant = "neutral" | "info" | "success" | "warning" | "danger";

type State = { label: string; title: string; variant: Variant };

const VARIANT_STYLE: Record<Variant, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  info: "bg-blue-100 text-blue-800",
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-900",
  danger: "bg-red-100 text-red-700",
};

function classify(tags: string[]): State {
  const set = new Set(tags);
  if (set.has("ai-error") || set.has("ai-propagation-error")) {
    return {
      label: "Fehler",
      title: "Verarbeitung fehlgeschlagen — über das Vorschau-Fenster erneut verarbeiten.",
      variant: "danger",
    };
  }
  if (set.has("ai-rejected")) {
    return {
      label: "Abgelehnt",
      title: "Du hast diese KI-Klassifizierung abgelehnt.",
      variant: "neutral",
    };
  }
  if (set.has("ai-pending")) {
    return {
      label: "In Inbox",
      title: "Wartet auf deine Prüfung in der Inbox.",
      variant: "warning",
    };
  }
  if (set.has("ai-approved")) {
    return {
      label: "Wird übertragen",
      title: "Genehmigt — der Propagator setzt die nativen Felder in Kürze.",
      variant: "info",
    };
  }
  if (set.has("ai-propagated")) {
    return {
      label: "Verarbeitet",
      title: "KI-Klassifizierung abgeschlossen.",
      variant: "success",
    };
  }
  if (set.has("ai-low-confidence")) {
    return {
      label: "Niedrige Konfidenz",
      title: "Die KI ist sich unsicher — bitte prüfen.",
      variant: "warning",
    };
  }
  return {
    label: "Wartet auf KI",
    title: "Noch keine KI-Klassifizierung — der Auto-Tagger holt das nach.",
    variant: "neutral",
  };
}

export function ProcessingBadge({
  tags,
  className = "",
}: {
  tags: string[];
  className?: string;
}) {
  const state = classify(tags);
  return (
    <span
      title={state.title}
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${VARIANT_STYLE[state.variant]} ${className}`}
    >
      {state.label}
    </span>
  );
}
