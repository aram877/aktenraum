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

export interface LiveCountsStream {
  start(): void;
  stop(): void;
}

export function createLiveCountsStream(queryClient: QueryClient): LiveCountsStream {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  function connect(): void {
    if (!started || typeof EventSource === "undefined") return;
    source?.close();
    const current = new EventSource("/api/events/counts", { withCredentials: true });
    source = current;
    current.onmessage = (event: MessageEvent<string>) => {
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
      connect();
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
