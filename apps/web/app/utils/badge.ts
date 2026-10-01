export type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";

export interface BadgeState {
  label: string;
  title: string;
  variant: BadgeVariant;
}

export const VARIANT_STYLE: Record<BadgeVariant, string> = {
  neutral: "bg-surface-raised text-ink-muted border border-hairline",
  info: "bg-accent/10 text-accent",
  success: "bg-emerald-50 text-emerald-800",
  warning: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-700",
};

export function classify(tags: readonly string[], errorMessage?: string | null): BadgeState {
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
      title: "Automatisch genehmigt wegen hoher Konfidenz (≥ 90 %). Keine manuelle Prüfung.",
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
