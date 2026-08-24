import { Injectable } from "@nestjs/common";

import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";

export interface LiveCounts {
  inbox: number;
  in_flight: number;
  trash: number;
}

// In-flight = docs the worker or propagator is currently handling. Mirrors
// the definition in documents.service.ts.
const IN_FLIGHT_TAGS = ["ai-pending", "ai-approved"] as const;
const PENDING_TAG = "ai-pending";

function countOf(payload: Record<string, unknown>): number {
  const raw = payload["count"];
  return typeof raw === "number" ? raw : 0;
}

@Injectable()
export class EventsService {
  constructor(private readonly gatewayProvider: PaperlessGatewayProvider) {}

  /**
   * One pass: inbox + in-flight + trash counts. All three queries run
   * concurrently so the poll cadence is bounded by the slowest single
   * request rather than their sum.
   */
  async computeCounts(): Promise<LiveCounts> {
    const gateway = this.gatewayProvider.require();
    const tags = await gateway.listTags();
    const pendingId = tags[PENDING_TAG];
    const flightIds = IN_FLIGHT_TAGS.map((name) => tags[name]).filter(
      (id): id is number => id !== undefined,
    );

    const [inbox, inFlight, trash] = await Promise.all([
      pendingId === undefined
        ? Promise.resolve(0)
        : gateway
            .searchDocuments({ tags__id__in: String(pendingId) }, { pageSize: 1 })
            .then(countOf),
      flightIds.length === 0
        ? Promise.resolve(0)
        : gateway
            .searchDocuments({ tags__id__in: flightIds.join(",") }, { pageSize: 1 })
            .then(countOf),
      gateway.listTrashedDocuments({ page: 1, pageSize: 1 }).then(countOf),
    ]);

    return { inbox, in_flight: inFlight, trash };
  }
}
