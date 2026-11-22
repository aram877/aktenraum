import { QueryClient } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

function open(): FakeEventSource[] {
  return FakeEventSource.instances.filter((s) => !s.closed);
}

describe("createLiveCountsStream", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens one credentialed connection however often start is called", () => {
    const stream = createLiveCountsStream(queryClient);
    stream.start();
    stream.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/events/counts");
    expect(FakeEventSource.instances[0]?.init).toEqual({ withCredentials: true });
  });

  it("writes each event into the live-counts cache entry", () => {
    const stream = createLiveCountsStream(queryClient);
    stream.start();
    FakeEventSource.instances[0]?.onmessage?.(
      new MessageEvent("message", { data: '{"inbox":2,"in_flight":3,"trash":1}' }),
    );
    expect(queryClient.getQueryData(LIVE_COUNTS_KEY)).toEqual({ inbox: 2, in_flight: 3, trash: 1 });
  });

  it("ignores a malformed frame instead of tearing the stream down", () => {
    const stream = createLiveCountsStream(queryClient);
    stream.start();
    expect(() =>
      FakeEventSource.instances[0]?.onmessage?.(new MessageEvent("message", { data: "{nope" })),
    ).not.toThrow();
    expect(open()).toHaveLength(1);
  });

  it("reconnects after a 5 second back-off, not in a tight loop", () => {
    const stream = createLiveCountsStream(queryClient);
    stream.start();
    FakeEventSource.instances[0]?.onerror?.();
    FakeEventSource.instances[0]?.onerror?.();
    expect(open()).toHaveLength(0);
    vi.advanceTimersByTime(LIVE_RECONNECT_DELAY_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(open()).toHaveLength(1);
  });

  it("stop closes the connection and cancels a pending reconnect", () => {
    const stream = createLiveCountsStream(queryClient);
    stream.start();
    FakeEventSource.instances[0]?.onerror?.();
    stream.stop();
    vi.advanceTimersByTime(LIVE_RECONNECT_DELAY_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(open()).toHaveLength(0);
  });
});

describe("createLiveCountsStream: session ended", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops for good on session_ended and refetches me, without reconnecting", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const stream = createLiveCountsStream(queryClient);
    stream.start();
    FakeEventSource.instances[0]?.emit("session_ended");
    // The browser also fires onerror when the server closes the stream.
    FakeEventSource.instances[0]?.onerror?.();
    vi.advanceTimersByTime(LIVE_RECONNECT_DELAY_MS * 3);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(open()).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith({ queryKey: ME_KEY });
    // A later sign-in can start it again.
    stream.start();
    expect(open()).toHaveLength(1);
  });

  // Regression (2026-11-22): the server ended a session that /auth/me still
  // accepted, the plugin restarted the stream at once → ~140 reconnects/s.
  it("backs off when session_ended repeats while me still says signed in", () => {
    const queryClient = new QueryClient();
    const stream = createLiveCountsStream(queryClient);
    const endAndRestart = (): void => {
      open()[0]?.emit("session_ended");
      stream.start(); // what the plugin does when `me` resolves again
    };

    stream.start();
    endAndRestart();
    expect(FakeEventSource.instances).toHaveLength(1); // no instant reconnect
    vi.advanceTimersByTime(SESSION_ENDED_BACKOFF_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    endAndRestart(); // second in a row: twice the wait
    vi.advanceTimersByTime(SESSION_ENDED_BACKOFF_MS * 2 - 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // A counts frame means the stream works again: the streak resets.
    open()[0]?.onmessage?.(new MessageEvent("message", { data: '{"inbox":0,"in_flight":0,"trash":0}' }));
    endAndRestart();
    vi.advanceTimersByTime(SESSION_ENDED_BACKOFF_MS);
    expect(FakeEventSource.instances).toHaveLength(4);
    stream.stop();
  });
});

describe("live-counts plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the stream on sign-in and closes it on sign-out", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const queryClient = useNuxtApp().$queryClient;
    queryClient.setQueryData(ME_KEY, null);
    expect(open()).toHaveLength(0);
    queryClient.setQueryData(ME_KEY, { username: "admin" });
    expect(open()).toHaveLength(1);
    queryClient.setQueryData(ME_KEY, null);
    expect(open()).toHaveLength(0);
  });
});
