import { useQuery, type QueryClient } from "@tanstack/vue-query";

export interface LiveCounts {
  inbox: number;
  in_flight: number;
  trash: number;
  /** Absent when talking to an API older than the field. */
  errors?: number;
}

export const LIVE_COUNTS_KEY = ["live", "counts"] as const;

export const LIVE_RECONNECT_DELAY_MS = 5_000;

/**
 * After `session_ended` the plugin restarts the stream as soon as `me` still
 * resolves. If the server keeps ending a session that `/auth/me` accepts (a
 * server bug — 2026-11-22: ~140 reconnects/s), wait before each restart:
 * 5 s, doubling, capped at 60 s; any counts frame resets the streak.
 */
export const SESSION_ENDED_BACKOFF_MS = 5_000;
export const SESSION_ENDED_BACKOFF_MAX_MS = 60_000;

export interface LiveCountsStream {
  start(): void;
  stop(): void;
}

export function createLiveCountsStream(queryClient: QueryClient): LiveCountsStream {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let endedStreak = 0;
  let blockedUntil = 0;

  function connect(): void {
    if (!started || typeof EventSource === "undefined") return;
    source?.close();
    const current = new EventSource("/api/events/counts", { withCredentials: true });
    source = current;
    current.onmessage = (event: MessageEvent<string>) => {
      endedStreak = 0;
      blockedUntil = 0;
      try {
        queryClient.setQueryData(LIVE_COUNTS_KEY, JSON.parse(event.data) as LiveCounts);
      } catch {
        return;
      }
    };
    // The server ended the session (member removed): stop for good instead of
    // reconnecting into 401s, and let `me` find out — it resolves to null,
    // which also keeps the plugin from restarting the stream.
    current.addEventListener("session_ended", () => {
      endedStreak += 1;
      blockedUntil =
        Date.now() + Math.min(SESSION_ENDED_BACKOFF_MS * 2 ** (endedStreak - 1), SESSION_ENDED_BACKOFF_MAX_MS);
      stop();
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    });
    current.onerror = () => {
      current.close();
      if (source === current) source = null;
      if (!started || retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, LIVE_RECONNECT_DELAY_MS);
    };
  }

  function stop(): void {
    started = false;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    source?.close();
    source = null;
  }

  return {
    start() {
      if (started) return;
      started = true;
      const wait = blockedUntil - Date.now();
      if (wait <= 0) {
        connect();
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, wait);
    },
    stop,
  };
}

export function useLiveCounts() {
  return useQuery({
    queryKey: LIVE_COUNTS_KEY,
    queryFn: (): Promise<LiveCounts | null> => Promise.resolve(null),
    enabled: false,
    staleTime: Infinity,
  });
}
