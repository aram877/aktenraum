import { Component, computed, effect, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { toSignal } from "@angular/core/rxjs-interop";

import { detailFrom } from "../core/api";
import { registerShortcuts } from "../core/keyboard";
import { DOC_TYPES } from "../core/library";
import {
  buildDirtyPatch,
  detailToForm,
  EMPTY_FORM,
  FORM_FIELDS,
  injectApprove,
  injectInboxDetail,
  injectInboxList,
  injectReject,
  mergeHydration,
  pickNeighbour,
  type FormField,
  type FormState,
} from "../core/inbox";

@Component({
  selector: "app-inbox-review",
  imports: [FormsModule],
  templateUrl: "./inbox-review.html",
})
export class InboxReview {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);

  private readonly params = toSignal(this.route.paramMap, { requireSync: true });
  protected readonly id = computed(() => {
    const raw = this.params().get("id");
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  });

  protected readonly detail = injectInboxDetail(() => this.id());
  protected readonly list = injectInboxList({ pageSize: 50 });
  protected readonly approve = injectApprove(() => this.id() as number);
  protected readonly reject = injectReject(() => this.id() as number);

  protected readonly form = signal<FormState>({ ...EMPTY_FORM });
  protected readonly mobilePane = signal<"pdf" | "form">("form");
  private lastHydrated: FormState | null = null;
  private lastHydratedId: number | null = null;

  protected readonly docTypes = DOC_TYPES;
  protected readonly fields = FORM_FIELDS;

  protected readonly previewUrl = computed<SafeResourceUrl | null>(() => {
    const id = this.id();
    if (id === null) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(`/api/documents/${id}/preview`);
  });

  protected readonly anyPending = computed(
    () => this.approve.isPending() || this.reject.isPending(),
  );

  protected readonly errorText = computed(() => {
    if (this.approve.isError()) return detailFrom(this.approve.error(), "Genehmigen fehlgeschlagen.");
    if (this.reject.isError()) return detailFrom(this.reject.error(), "Ablehnen fehlgeschlagen.");
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
        return;
      }
      this.form.set(mergeHydration(this.form(), this.lastHydrated, next));
      this.lastHydrated = next;
    });

    registerShortcuts(
      () => ({
        a: () => void this.onApprove(),
        r: () => void this.onReject(),
        j: () => this.advance("next"),
        k: () => this.advance("prev"),
        Escape: () => this.backToList(),
      }),
      () => this.detail.isSuccess(),
    );
  }

  protected setField(field: FormField, value: string): void {
    this.form.set({ ...this.form(), [field]: value });
  }

  protected backToList(): void {
    void this.router.navigate(["/library"], { queryParams: { tab: "review" } });
  }

  protected advance(direction: "next" | "prev"): void {
    const id = this.id();
    if (id === null) return;
    const ids = this.list.data()?.results.map((r) => r.id) ?? [];
    const target = pickNeighbour(ids, id, direction);
    if (target === undefined) {
      this.backToList();
      return;
    }
    void this.router.navigate(["/inbox", target]);
  }

  protected async onApprove(): Promise<void> {
    const data = this.detail.data();
    if (!data) return;
    const patch = buildDirtyPatch(this.form(), data);
    try {
      await this.approve.mutateAsync(Object.keys(patch).length > 0 ? patch : undefined);
      this.advance("next");
    } catch {
      return;
    }
  }

  protected async onReject(): Promise<void> {
    try {
      await this.reject.mutateAsync();
      this.advance("next");
    } catch {
      return;
    }
  }
}
