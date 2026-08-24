import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Response } from "express";

export async function pipeUpstreamToResponse(
  upstream: Response_,
  response: Response,
  options: {
    contentType?: string;
    forwardHeaders?: string[];
    headers?: Record<string, string>;
  } = {},
): Promise<void> {
  if (options.contentType !== undefined) {
    response.setHeader("Content-Type", options.contentType);
  }
  for (const header of options.forwardHeaders ?? []) {
    const value = upstream.headers.get(header);
    if (value !== null) response.setHeader(header, value);
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    response.setHeader(key, value);
  }

  if (upstream.body === null) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), response);
}

type Response_ = globalThis.Response;
