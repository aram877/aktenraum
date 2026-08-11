export type Slot = "extraction" | "propagation" | "indexer";

/**
 * Advisory snapshot of which doc each pipeline stage is handling right now.
 * Each stage is a single serial consumer of its own queue, so a slot only
 * ever holds 0 or 1 id. Deliberately lock-free: the data drives a spinner,
 * a one-second-stale read is fine, and a lock would couple the workers to
 * the HTTP listener for no benefit.
 */
export class ProcessingState {
  private slots: Record<Slot, number | null> = {
    extraction: null,
    propagation: null,
    indexer: null,
  };

  set(slot: Slot, docId: number | null): void {
    this.slots[slot] = docId;
  }

  snapshot(): Record<Slot, number | null> {
    return { ...this.slots };
  }

  activeIds(): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const value of Object.values(this.slots)) {
      if (value !== null && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  }
}
