import { DestroyRef, inject, Injectable } from "@angular/core";
import { injectQuery, QueryClient } from "@tanstack/angular-query-experimental";

export interface LiveCounts {
  inbox: number;
  in_flight: number;
  trash: number;
}

export const LIVE_COUNTS_KEY = ["live", "counts"] as const;

const RECONNECT_DELAY_MS = 5_000;

/**
 * Subscribes to /api/events/counts and projects each event into the query
 * cache. Consumers read it with `injectLiveCounts()` — plain injectQuery
 * against the same key, no extra plumbing.
 *
 * The browser's EventSource reconnects on its own, but if the connection
 * opens and the server then closes it (a 502 from nginx mid-deploy, say) it
 * retries almost immediately and spins. Hence the manual back-off.
 */
@Injectable({ providedIn: "root" })
export class LiveCountsSubscription {
  private readonly queryClient = inject(QueryClient);
  private source: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  private connect(): void {
    if (!this.started) return;
    // No EventSource under SSR or the unit-test environment. The nav's
    // polled queries are the fallback, so degrade silently rather than
    // throwing out of an effect.
    if (typeof EventSource === "undefined") return;
    this.source?.close();

    const source = new EventSource("/api/events/counts", { withCredentials: true });
    this.source = source;

    source.onmessage = (event: MessageEvent<string>) => {
      try {
        this.queryClient.setQueryData(LIVE_COUNTS_KEY, JSON.parse(event.data) as LiveCounts);
      } catch {
        // A malformed frame is not worth tearing the stream down for; the
        // next tick carries the same counts.
      }
    };

    source.onerror = () => {
      source.close();
      if (this.source === source) this.source = null;
      if (!this.started || this.retryTimer !== null) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, RECONNECT_DELAY_MS);
    };
  }
}

export function injectLiveCounts() {
  return injectQuery(() => ({
    queryKey: LIVE_COUNTS_KEY,
    // Pushed into the cache by LiveCountsSubscription; there is nothing to
    // pull. staleTime Infinity stops TanStack from ever calling queryFn.
    queryFn: (): Promise<LiveCounts | undefined> => Promise.resolve(undefined),
    enabled: false,
    staleTime: Infinity,
  }));
}
