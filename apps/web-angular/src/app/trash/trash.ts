import { Component, computed, signal } from "@angular/core";

import { detailFrom } from "../core/api";
import {
  daysLeft,
  injectDeleteForever,
  injectEmptyTrash,
  injectRestore,
  injectTrashList,
  type TrashItem,
} from "../core/trash";

@Component({
  selector: "app-trash",
  templateUrl: "./trash.html",
})
export class Trash {
  protected readonly list = injectTrashList();
  protected readonly restore = injectRestore();
  protected readonly deleteForever = injectDeleteForever();
  protected readonly emptyTrash = injectEmptyTrash();

  protected readonly confirmingDelete = signal<number | null>(null);
  protected readonly confirmingEmpty = signal(false);

  protected readonly rows = computed<readonly TrashItem[]>(
    () => this.list.data()?.results ?? [],
  );
  protected readonly total = computed(() => this.list.data()?.total ?? 0);

  protected readonly errorText = computed(() => {
    if (this.restore.isError()) return detailFrom(this.restore.error(), "Wiederherstellen fehlgeschlagen.");
    if (this.deleteForever.isError()) {
      return detailFrom(this.deleteForever.error(), "Löschen fehlgeschlagen.");
    }
    if (this.emptyTrash.isError()) return detailFrom(this.emptyTrash.error(), "Leeren fehlgeschlagen.");
    return null;
  });

  protected remaining(item: TrashItem): string {
    const days = daysLeft(item.deleted_at);
    return days === null ? "—" : `noch ${days} Tage`;
  }

  protected async onRestore(id: number): Promise<void> {
    await this.restore.mutateAsync(id).catch(() => undefined);
  }

  protected async onDelete(id: number): Promise<void> {
    if (this.confirmingDelete() !== id) {
      this.confirmingDelete.set(id);
      return;
    }
    this.confirmingDelete.set(null);
    await this.deleteForever.mutateAsync(id).catch(() => undefined);
  }

  protected async onEmpty(): Promise<void> {
    if (!this.confirmingEmpty()) {
      this.confirmingEmpty.set(true);
      return;
    }
    this.confirmingEmpty.set(false);
    await this.emptyTrash.mutateAsync().catch(() => undefined);
  }
}
