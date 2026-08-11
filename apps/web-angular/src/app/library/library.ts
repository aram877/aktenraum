import { Component, computed, effect, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { toSignal } from "@angular/core/rxjs-interop";

import { detailFrom } from "../core/api";
import { userFacingTags } from "../core/lifecycle-tags";
import {
  DOC_TYPES,
  ORDERING_OPTIONS,
  injectLibrary,
  injectTagFacet,
  type LibraryItem,
  type LibraryQuery,
} from "../core/library";
import { ProcessingBadge } from "../shared/processing-badge";
import { Review } from "./review";

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 400;

export function sortTagsImportantFirst(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => {
    if (a === "wichtig") return -1;
    if (b === "wichtig") return 1;
    return a.localeCompare(b, "de");
  });
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

@Component({
  selector: "app-library",
  imports: [FormsModule, RouterLink, ProcessingBadge, Review],
  templateUrl: "./library.html",
})
export class Library {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });

  protected readonly documentType = signal("");
  protected readonly correspondent = signal("");
  protected readonly dateFrom = signal("");
  protected readonly dateTo = signal("");
  protected readonly text = signal("");
  protected readonly ordering = signal("-created");
  protected readonly selectedTags = signal<readonly string[]>([]);
  protected readonly page = signal(1);
  protected readonly filtersOpen = signal(false);
  protected readonly tab = signal<"archive" | "review">("archive");

  private readonly debouncedText = signal("");
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  protected readonly docTypes = DOC_TYPES;
  protected readonly orderingOptions = ORDERING_OPTIONS;

  protected readonly query = computed<LibraryQuery>(() => ({
    document_type: this.documentType() || null,
    correspondent: this.correspondent() || null,
    date_from: this.dateFrom() || null,
    date_to: this.dateTo() || null,
    text: this.debouncedText() || null,
    tags: this.selectedTags().length > 0 ? [...this.selectedTags()] : null,
    ordering: this.ordering(),
    page: this.page(),
    page_size: PAGE_SIZE,
  }));

  protected readonly library = injectLibrary(() => this.query());
  protected readonly facet = injectTagFacet();

  protected readonly rows = computed<readonly LibraryItem[]>(
    () => this.library.data()?.results ?? [],
  );
  protected readonly total = computed(() => this.library.data()?.total ?? 0);
  protected readonly pages = computed(() => totalPages(this.total(), PAGE_SIZE));
  protected readonly errorText = computed(() =>
    this.library.isError() ? detailFrom(this.library.error(), "Laden fehlgeschlagen.") : null,
  );
  protected readonly hasActiveFilters = computed(
    () =>
      Boolean(this.documentType() || this.correspondent() || this.dateFrom() || this.dateTo()) ||
      Boolean(this.text()) ||
      this.selectedTags().length > 0,
  );

  constructor() {
    effect(() => {
      const p = this.params();
      this.documentType.set(p.get("document_type") ?? "");
      this.correspondent.set(p.get("correspondent") ?? "");
      this.dateFrom.set(p.get("date_from") ?? "");
      this.dateTo.set(p.get("date_to") ?? "");
      const t = p.get("text") ?? "";
      this.text.set(t);
      this.debouncedText.set(t);
      this.ordering.set(p.get("ordering") ?? "-created");
      this.selectedTags.set(p.getAll("tags"));
      const page = Number.parseInt(p.get("page") ?? "1", 10);
      this.page.set(Number.isFinite(page) && page > 0 ? page : 1);
      this.tab.set(p.get("tab") === "review" ? "review" : "archive");
    });
  }

  protected userTags(item: LibraryItem): string[] {
    return sortTagsImportantFirst(userFacingTags(item.tags));
  }

  protected onTextInput(value: string): void {
    this.text.set(value);
    if (this.debounceHandle !== null) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.debouncedText.set(value);
      this.syncUrl({ text: value, page: 1 });
    }, DEBOUNCE_MS);
  }

  protected onFilterChange(patch: Partial<Record<string, string>>): void {
    this.syncUrl({ ...patch, page: 1 });
  }

  protected toggleTag(name: string): void {
    const current = this.selectedTags();
    const next = current.includes(name)
      ? current.filter((t) => t !== name)
      : [...current, name];
    this.selectedTags.set(next);
    this.syncUrl({ tags: next, page: 1 });
  }

  protected switchTab(tab: "archive" | "review"): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: tab === "review" ? { tab: "review" } : {},
    });
  }

  protected clearFilters(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: {} });
  }

  protected goToPage(next: number): void {
    if (next < 1 || next > this.pages()) return;
    this.syncUrl({ page: next });
  }

  private syncUrl(patch: Record<string, unknown>): void {
    const merged: Record<string, unknown> = {
      document_type: this.documentType() || null,
      correspondent: this.correspondent() || null,
      date_from: this.dateFrom() || null,
      date_to: this.dateTo() || null,
      text: this.text() || null,
      ordering: this.ordering(),
      tags: this.selectedTags().length > 0 ? [...this.selectedTags()] : null,
      page: this.page(),
      ...patch,
    };
    const queryParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
        continue;
      }
      if (key === "page" && value === 1) continue;
      if (key === "ordering" && value === "-created") continue;
      queryParams[key] = value;
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams });
  }
}
