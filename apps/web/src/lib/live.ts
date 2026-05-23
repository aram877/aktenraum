import { useEffect } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

export type LiveCounts = {
  inbox: number;
  in_flight: number;
  trash: number;
};

export const LIVE_COUNTS_KEY = ["live", "counts"] as const;

/**
 * Subscribe to /api/events/counts (SSE) and project each event into a
 * TanStack query cache. The Nav badges read from {@link useLiveCounts}
 * which is plain `useQuery` against the same key — no extra plumbing.
 *
 * The browser's native EventSource handles reconnect for us. We layer
 * a manual back-off only for the case where the connection opens but
 * the server then closes it (e.g. a 502 from nginx during deploy):
 * EventSource auto-reconnects almost immediately, which would spin in
 * a tight loop. Capping retries at one per 5s prevents that.
 */
export function useLiveCountsSubscription() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/events/counts", { withCredentials: true });
      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data) as LiveCounts;
          qc.setQueryData(LIVE_COUNTS_KEY, payload);
        } catch {
          // Ignore malformed events — the next valid one wins.
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        // 5s floor on reconnect attempts so we don't spin during a
        // backend restart.
        retryTimer = window.setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      es?.close();
    };
  }, [qc]);
}

/**
 * Read the latest live-counts snapshot from cache. Returns `undefined`
 * until the first event arrives (typically within ~3s of subscription
 * opening, since the server emits the initial snapshot on connect).
 */
export function useLiveCounts() {
  return useQuery<LiveCounts>({
    queryKey: LIVE_COUNTS_KEY,
    // No queryFn — this query exists purely as a state container; the
    // SSE subscription writes into it via setQueryData.
    enabled: false,
    staleTime: Infinity,
  });
}
