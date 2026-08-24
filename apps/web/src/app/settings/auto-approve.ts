import { Component, computed, effect, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { detailFrom } from "../core/api";
import {
  injectAutoApproveRules,
  injectUpdateAutoApproveRules,
  type AutoApproveRule,
} from "../core/settings";

export interface DraftEntry {
  enabled: boolean;
  min_confidence: number;
}

export function buildDraft(rules: readonly AutoApproveRule[]): Map<string, DraftEntry> {
  const draft = new Map<string, DraftEntry>();
  for (const rule of rules) {
    draft.set(rule.document_type, {
      enabled: rule.enabled,
      min_confidence: rule.min_confidence,
    });
  }
  return draft;
}

export function isDirty(
  rules: readonly AutoApproveRule[],
  draft: Map<string, DraftEntry>,
): boolean {
  for (const rule of rules) {
    const entry = draft.get(rule.document_type);
    if (!entry) return true;
    if (entry.enabled !== rule.enabled) return true;
    if (entry.min_confidence !== rule.min_confidence) return true;
  }
  return false;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

const LOW_CONFIDENCE_THRESHOLD = 0.7;

@Component({
  selector: "app-auto-approve",
  imports: [FormsModule],
  templateUrl: "./auto-approve.html",
})
export class AutoApprove {
  protected readonly query = injectAutoApproveRules();
  protected readonly update = injectUpdateAutoApproveRules();

  protected readonly draft = signal<Map<string, DraftEntry>>(new Map());
  protected readonly showSaved = signal(false);

  protected readonly rules = computed<readonly AutoApproveRule[]>(
    () => this.query.data()?.rules ?? [],
  );

  protected readonly sortedRules = computed(() =>
    [...this.rules()].sort((a, b) => a.document_type.localeCompare(b.document_type, "de")),
  );

  protected readonly dirty = computed(() => isDirty(this.rules(), this.draft()));

  protected readonly errorBanner = computed(() => {
    if (this.query.isError()) return detailFrom(this.query.error(), "Regeln nicht ladbar.");
    if (this.update.isError()) {
      return detailFrom(this.update.error(), "Speichern fehlgeschlagen.");
    }
    return null;
  });

  constructor() {
    effect(() => {
      const rules = this.query.data()?.rules;
      if (rules) this.draft.set(buildDraft(rules));
    });
  }

  protected entryFor(documentType: string): DraftEntry {
    return this.draft().get(documentType) ?? { enabled: false, min_confidence: 0.9 };
  }

  protected isLow(rule: AutoApproveRule): boolean {
    return rule.min_confidence < LOW_CONFIDENCE_THRESHOLD;
  }

  protected formatted(value: string | null): string {
    return formatTimestamp(value);
  }

  protected setEnabled(documentType: string, enabled: boolean): void {
    const next = new Map(this.draft());
    next.set(documentType, { ...this.entryFor(documentType), enabled });
    this.draft.set(next);
  }

  protected setMinConfidence(documentType: string, raw: string): void {
    const parsed = Number.parseFloat(raw || "0");
    const next = new Map(this.draft());
    next.set(documentType, {
      ...this.entryFor(documentType),
      min_confidence: Number.isFinite(parsed) ? parsed : 0,
    });
    this.draft.set(next);
  }

  protected toggleAll(enabled: boolean): void {
    const next = new Map(this.draft());
    for (const [key, entry] of next) next.set(key, { ...entry, enabled });
    this.draft.set(next);
  }

  protected reset(): void {
    this.draft.set(buildDraft(this.rules()));
  }

  protected async onSave(): Promise<void> {
    const payload = this.rules().map((rule) => {
      const entry = this.entryFor(rule.document_type);
      return {
        document_type: rule.document_type,
        enabled: entry.enabled,
        min_confidence: entry.min_confidence,
      };
    });
    try {
      await this.update.mutateAsync(payload);
      this.showSaved.set(true);
      setTimeout(() => this.showSaved.set(false), 3000);
    } catch {
      return;
    }
  }
}
