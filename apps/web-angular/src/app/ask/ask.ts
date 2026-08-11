import { Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";

import { AskApi, type DocumentSummary, type StreamMeta } from "../core/ask";

@Component({
  selector: "app-ask",
  imports: [FormsModule, RouterLink],
  templateUrl: "./ask.html",
})
export class Ask {
  private readonly api = inject(AskApi);
  private readonly destroyRef = inject(DestroyRef);
  private controller: AbortController | null = null;

  protected readonly question = signal("");
  protected readonly answer = signal("");
  protected readonly meta = signal<StreamMeta | null>(null);
  protected readonly citations = signal<readonly DocumentSummary[]>([]);
  protected readonly errorText = signal<string | null>(null);
  protected readonly streaming = signal(false);

  protected readonly canSubmit = computed(
    () => this.question().trim().length > 0 && !this.streaming(),
  );

  constructor() {
    this.destroyRef.onDestroy(() => this.controller?.abort());
  }

  protected onSubmit(): void {
    const q = this.question().trim();
    if (!q || this.streaming()) return;
    this.controller?.abort();
    this.answer.set("");
    this.meta.set(null);
    this.citations.set([]);
    this.errorText.set(null);
    this.streaming.set(true);

    this.controller = this.api.stream(q, {
      onMeta: (meta) => this.meta.set(meta),
      onChunk: (delta) => this.answer.set(this.answer() + delta),
      onFinal: (final) => {
        this.answer.set(final.answer_de);
        this.citations.set(final.citations);
        this.streaming.set(false);
      },
      onError: (detail) => {
        this.errorText.set(detail);
        this.streaming.set(false);
      },
    });
  }

  protected stop(): void {
    this.controller?.abort();
    this.streaming.set(false);
  }
}
