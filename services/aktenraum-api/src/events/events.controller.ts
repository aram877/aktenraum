import { logger } from "@aktenraum/core";
import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { AuthGuard } from "../auth/auth.guard.js";
import { PaperlessAuthError } from "../paperless/errors.js";
import { EventsService, type LiveCounts } from "./events.service.js";

// How often to recompute. 3s is the responsiveness target: anything slower
// and the user notices the badge ticking as they cross between pages.
const POLL_INTERVAL_MS = 3_000;

// nginx drops idle connections at proxy_read_timeout. Emit at least this
// often even when nothing changed, so the stream is never idle long enough
// to be reaped.
const HEARTBEAT_MS = 25_000;

function sameCounts(a: LiveCounts | null, b: LiveCounts): boolean {
  return a !== null && a.inbox === b.inbox && a.in_flight === b.in_flight && a.trash === b.trash;
}

@Controller("events")
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * Server-Sent Events stream of {inbox, in_flight, trash}.
   *
   * One event on connect, then one per change, plus a heartbeat. Replaces
   * three independent polling timers in the SPA with a single push stream.
   *
   * SSE rather than WebSockets because the client never talks back: it rides
   * plain HTTP, needs no nginx special-casing, and EventSource reconnects on
   * its own.
   *
   * Server-side polling per connection rather than shared pub/sub because
   * this is a single-user product — one or two tabs open, three Paperless
   * calls every 3s. A shared task with fanout would be premature.
   */
  @Get("counts")
  @UseGuards(AuthGuard)
  async streamCounts(@Res() response: Response): Promise<void> {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    let closed = false;
    response.on("close", () => {
      closed = true;
    });

    let last: LiveCounts | null = null;
    let lastEmit = 0;

    while (!closed) {
      try {
        const counts = await this.eventsService.computeCounts();
        const now = Date.now();
        if (!sameCounts(last, counts) || now - lastEmit >= HEARTBEAT_MS) {
          response.write(`data: ${JSON.stringify(counts)}\n\n`);
          last = counts;
          lastEmit = now;
        }
      } catch (error: unknown) {
        if (error instanceof PaperlessAuthError) {
          // Token rotated or removed. Emit a sentinel and stop: on reconnect
          // the auth guard gives the client a 401 it can back off from.
          response.write("event: error\ndata: paperless_auth\n\n");
          break;
        }
        // Transient. Keep the stream open and retry on the next tick; the
        // comment frame doubles as a heartbeat so nginx does not reap us.
        logger.warn("events_counts_poll_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        response.write(": stale\n\n");
      }

      if (closed) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    response.end();
  }
}
