import { Component, computed, signal } from "@angular/core";
import { RouterLink } from "@angular/router";

import { injectBulkApprove, injectInboxListInfinite, type InboxItem } from "../core/inbox";

export function pruneSelection(
  selected: ReadonlySet<number>,
  visibleIds: readonly number[],
): Set<number> {
  if (visibleIds.length === 0) return new Set(selected);
  const visible = new Set(visibleIds);
  const next = new Set<number>();
  for (const id of selected) if (visible.has(id)) next.add(id);
  return next;
}

export function formatConfidence(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)} %`;
}

@Component({
  selector: "app-review",
  imports: [RouterLink],
  templateUrl: "./review.html",
})
export class Review {
  protected readonly list = injectInboxListInfinite({ pageSize: 50, ordering: "-modified" });
  protected readonly bulkApprove = injectBulkApprove();

  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  protected readonly lastResult = signal<{ succeeded: number; failed: number } | null>(null);

  protected readonly rows = computed<readonly InboxItem[]>(
    () => this.list.data()?.pages.flatMap((p) => p.results) ?? [],
  );
  protected readonly total = computed(() => this.list.data()?.pages[0]?.total ?? 0);
  protected readonly loaded = computed(() => this.rows().length);
  protected readonly visibleIds = computed(() => this.rows().map((r) => r.id));

  protected readonly effectiveSelected = computed(() =>
    pruneSelection(this.selected(), this.visibleIds()),
  );
  protected readonly selectedCount = computed(() => this.effectiveSelected().size);
  protected readonly allSelected = computed(() => {
    const ids = this.visibleIds();
    const sel = this.effectiveSelected();
    return ids.length > 0 && ids.every((id) => sel.has(id));
  });

  protected isChecked(id: number): boolean {
    return this.effectiveSelected().has(id);
  }

  protected confidence(value: number | null): string {
    return formatConfidence(value);
  }

  protected toggleOne(id: number): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected.set(next);
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.visibleIds()));
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected async onBulkApprove(): Promise<void> {
    const ids = [...this.effectiveSelected()];
    if (ids.length === 0) return;
    this.lastResult.set(null);
    const result = await this.bulkApprove.mutateAsync(ids);
    this.lastResult.set({
      succeeded: result.succeeded.length,
      failed: result.failed.length,
    });
    const next = new Set(this.selected());
    for (const id of result.succeeded) next.delete(id);
    this.selected.set(next);
  }

  protected loadMore(): void {
    void this.list.fetchNextPage();
  }
}
