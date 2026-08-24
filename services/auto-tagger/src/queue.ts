/**
 * Minimal async FIFO queue: the Node equivalent of the `asyncio.Queue[int]`
 * the Python worker shares between its poller, webhook listener and
 * extraction worker. Deliberately unbounded and in-process — matching the
 * existing design, which has no Redis-backed job queue and does not need
 * persistence across restarts (the 30s poller is the safety net).
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((value: T) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  /** Resolves with the next item, or `null` once the queue is closed and drained. */
  async pop(): Promise<T | null> {
    const existing = this.items.shift();
    if (existing !== undefined) return existing;
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve as (value: T) => void);
      if (this.closed) resolve(null);
    });
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null as T);
    }
  }
}
