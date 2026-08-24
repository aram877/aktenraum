import { Component, computed, effect, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { toSignal } from "@angular/core/rxjs-interop";

import { detailFrom } from "../core/api";
import {
  injectDocumentDetail,
  injectDocumentFieldsPatch,
  injectReprocess,
} from "../core/documents";
import {
  buildDirtyPatch,
  detailToForm,
  EMPTY_FORM,
  mergeHydration,
  type FormField,
  type FormState,
} from "../core/inbox";
import { DOC_TYPES } from "../core/library";

@Component({
  selector: "app-library-review",
  imports: [FormsModule],
  templateUrl: "./library-review.html",
})
export class LibraryReview {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);

  private readonly params = toSignal(this.route.paramMap, { requireSync: true });
  protected readonly id = computed(() => {
    const parsed = Number.parseInt(this.params().get("id") ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  });

  protected readonly detail = injectDocumentDetail(() => this.id());
  protected readonly patch = injectDocumentFieldsPatch(() => this.id() as number);
  protected readonly reprocess = injectReprocess();

  protected readonly form = signal<FormState>({ ...EMPTY_FORM });
  protected readonly mobilePane = signal<"pdf" | "form">("form");
  protected readonly savedAt = signal<number | null>(null);
  protected readonly confirmingReprocess = signal(false);
  private lastHydrated: FormState | null = null;
  private lastHydratedId: number | null = null;

  protected readonly docTypes = DOC_TYPES;

  protected readonly previewUrl = computed<SafeResourceUrl | null>(() => {
    const id = this.id();
    if (id === null) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(`/api/documents/${id}/preview`);
  });

  protected readonly downloadUrl = computed(() => `/api/documents/${this.id()}/download`);

  protected readonly dirty = computed(() => {
    const data = this.detail.data();
    if (!data) return false;
    return Object.keys(buildDirtyPatch(this.form(), data)).length > 0;
  });

  protected readonly errorText = computed(() => {
    if (this.patch.isError()) return detailFrom(this.patch.error(), "Speichern fehlgeschlagen.");
    if (this.reprocess.isError()) {
      return detailFrom(this.reprocess.error(), "Erneut verarbeiten fehlgeschlagen.");
    }
    return null;
  });

  constructor() {
    effect(() => {
      const data = this.detail.data();
      if (!data) return;
      const next = detailToForm(data);
      if (this.lastHydratedId !== data.id) {
        this.form.set(next);
        this.lastHydrated = next;
        this.lastHydratedId = data.id;
        this.confirmingReprocess.set(false);
        return;
      }
      this.form.set(mergeHydration(this.form(), this.lastHydrated, next));
      this.lastHydrated = next;
    });
  }

  protected setField(field: FormField, value: string): void {
    this.form.set({ ...this.form(), [field]: value });
  }

  protected back(): void {
    void this.router.navigate(["/library"]);
  }

  protected reset(): void {
    const data = this.detail.data();
    if (data) this.form.set(detailToForm(data));
  }

  protected async onSave(): Promise<void> {
    const data = this.detail.data();
    if (!data) return;
    const body = buildDirtyPatch(this.form(), data);
    if (Object.keys(body).length === 0) return;
    try {
      await this.patch.mutateAsync(body);
      this.savedAt.set(Date.now());
      setTimeout(() => this.savedAt.set(null), 3000);
    } catch {
      return;
    }
  }

  protected async onReprocess(): Promise<void> {
    const id = this.id();
    if (id === null) return;
    if (!this.confirmingReprocess()) {
      this.confirmingReprocess.set(true);
      return;
    }
    try {
      await this.reprocess.mutateAsync(id);
      this.confirmingReprocess.set(false);
      void this.router.navigate(["/library"]);
    } catch {
      this.confirmingReprocess.set(false);
    }
  }
}
