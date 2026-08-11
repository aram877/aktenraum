import { Component, DestroyRef, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";

import {
  PHASE_LABEL,
  UploadApi,
  phaseFromTags,
  type UploadPhase,
} from "../core/upload";

interface FileState {
  name: string;
  phase: UploadPhase;
  detail: string | null;
  docId: number | null;
}

const TASK_POLL_MS = 1500;
const STATUS_POLL_MS = 3000;
const POLL_CEILING_MS = 120_000;

@Component({
  selector: "app-upload",
  imports: [RouterLink],
  templateUrl: "./upload.html",
})
export class Upload {
  private readonly api = inject(UploadApi);
  private readonly destroyRef = inject(DestroyRef);
  private cancelled = false;

  protected readonly files = signal<readonly FileState[]>([]);
  protected readonly dragging = signal(false);
  protected readonly busy = signal(false);
  protected readonly label = PHASE_LABEL;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cancelled = true;
    });
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDragLeave(): void {
    this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length > 0) void this.send(dropped);
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = "";
    if (picked.length > 0) void this.send(picked);
  }

  private update(name: string, patch: Partial<FileState>): void {
    this.files.set(this.files().map((f) => (f.name === name ? { ...f, ...patch } : f)));
  }

  private async send(picked: File[]): Promise<void> {
    this.busy.set(true);
    this.files.set(
      picked.map((f) => ({ name: f.name, phase: "uploading", detail: null, docId: null })),
    );
    try {
      const response = await this.api.upload(picked);
      for (const result of response.results) {
        if (result.status === "error") {
          this.update(result.filename, { phase: "error", detail: result.detail ?? null });
          continue;
        }
        this.update(result.filename, { phase: "consuming" });
        if (result.task_id) void this.track(result.filename, result.task_id);
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.files.set(this.files().map((f) => ({ ...f, phase: "error", detail })));
    } finally {
      this.busy.set(false);
    }
  }

  private async track(filename: string, taskId: string): Promise<void> {
    const deadline = Date.now() + POLL_CEILING_MS;
    let docId: number | null = null;
    while (!this.cancelled && Date.now() < deadline && docId === null) {
      await new Promise((r) => setTimeout(r, TASK_POLL_MS));
      if (this.cancelled) return;
      try {
        const task = await this.api.task(taskId);
        if (task.status === "SUCCESS" && task.doc_id) docId = task.doc_id;
        else if (task.status === "FAILURE") {
          this.update(filename, { phase: "error", detail: task.result ?? null });
          return;
        }
      } catch {
        continue;
      }
    }
    if (docId === null) return;
    this.update(filename, { phase: "classifying", docId });

    while (!this.cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
      if (this.cancelled) return;
      try {
        const status = await this.api.status(docId);
        const phase = phaseFromTags(status.lifecycle_tags);
        if (phase !== null) {
          this.update(filename, { phase });
          return;
        }
      } catch {
        continue;
      }
    }
  }
}
