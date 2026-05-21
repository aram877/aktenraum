/**
 * Status pill rendered next to a document anywhere it appears.
 * Precedence (top wins):
 *   ai-error / ai-propagation-error → "Fehler"
 *   ai-rejected                     → "Abgelehnt"
 *   ai-pending                      → "Bereit zum Prüfen"
 *   ai-propagated + ai-auto-approved → "Auto-genehmigt"
 *   ai-approved + ai-auto-approved   → "Auto-genehmigt (wird übertragen)"
 *   ai-approved                     → "Wird übertragen"
 *   ai-propagated                   → "Verarbeitet"
 *   ai-low-confidence (alone)       → "Niedrige Konfidenz"
 *   (no lifecycle tag)              → "Wartet auf KI"
 */

type Variant = "neutral" | "info" | "success" | "warning" | "danger";

type State = { label: string; title: string; variant: Variant };

const VARIANT_STYLE: Record<Variant, string> = {
  neutral: "bg-surface-raised text-ink-muted border border-hairline",
  info: "bg-accent/10 text-accent",
  success: "bg-emerald-50 text-emerald-800",
  warning: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-700",
};

function classify(tags: string[], errorMessage?: string | null): State {
  const set = new Set(tags);
  if (set.has("ai-error") || set.has("ai-propagation-error")) {
    const reason = (errorMessage ?? "").trim();
    return {
      label: "Fehler",
      title: reason
        ? `Verarbeitung fehlgeschlagen: ${reason}`
        : "Verarbeitung fehlgeschlagen — über das Vorschau-Fenster erneut verarbeiten.",
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
      label: "Bereit zum Prüfen",
      title: "Wartet auf deine Prüfung.",
      variant: "warning",
    };
  }
  if (set.has("ai-auto-approved") && set.has("ai-approved")) {
    return {
      label: "Auto-genehmigt · überträgt",
      title:
        "Automatisch genehmigt (Konfidenz ≥ 90 %). Der Propagator setzt die nativen Felder in Kürze.",
      variant: "info",
    };
  }
  if (set.has("ai-auto-approved") && set.has("ai-propagated")) {
    return {
      label: "Auto-genehmigt",
      title:
        "Automatisch genehmigt wegen hoher Konfidenz (≥ 90 %). Keine manuelle Prüfung.",
      variant: "success",
    };
  }
  if (set.has("ai-auto-approved")) {
    return {
      label: "Auto-genehmigt",
      title: "Automatisch genehmigt wegen hoher Konfidenz (≥ 90 %).",
      variant: "success",
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
  errorMessage,
  inFlight = false,
  className = "",
}: {
  tags: string[];
  errorMessage?: string | null;
  inFlight?: boolean;
  className?: string;
}) {
  if (inFlight) {
    return (
      <span
        title="Wird gerade vom Auto-Tagger bearbeitet."
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${VARIANT_STYLE.info} ${className}`}
      >
        <Spinner />
        <span>Wird verarbeitet…</span>
      </span>
    );
  }

  const state = classify(tags, errorMessage);
  const hasDuplicate = tags.includes("ai-duplicate");
  const hasEmail = tags.includes("email-ingested");

  const extraPills = (
    <>
      {hasEmail && (
        <span
          title="Per E-Mail eingegangen."
          className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-sky-100 text-sky-700"
        >
          E-Mail
        </span>
      )}
      {hasDuplicate && (
        <span
          title="Mögliches Duplikat erkannt — bitte im Vorschau-Fenster prüfen."
          className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800"
        >
          Duplikat?
        </span>
      )}
    </>
  );

  if (!hasDuplicate && !hasEmail) {
    return (
      <span
        title={state.title}
        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${VARIANT_STYLE[state.variant]} ${className}`}
      >
        {state.label}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        title={state.title}
        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${VARIANT_STYLE[state.variant]}`}
      >
        {state.label}
      </span>
      {extraPills}
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}
