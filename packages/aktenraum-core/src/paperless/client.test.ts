import { describe, expect, it } from "vitest";
import { LIFECYCLE_TAGS, PaperlessClient } from "./client.js";

// Mirrors services/auto-tagger/tests/test_paperless.py's TestSetErrorMessage
// and TestLifecycleTags classes.

type Handler = (req: { method: string; url: URL; body?: unknown }) => {
  status: number;
  json?: unknown;
};

function clientWithHandler(handler: Handler): PaperlessClient {
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const result = handler({ method: (init?.method ?? "GET").toUpperCase(), url, body });
    return new Response(result.json !== undefined ? JSON.stringify(result.json) : "", {
      status: result.status,
    });
  }) as typeof fetch;

  return new PaperlessClient("http://paperless.test", "tok", { fetchFn });
}

const CUSTOM_FIELDS_PAGE = {
  results: [
    { id: 1, name: "ai_document_type" },
    { id: 2, name: "ai_correspondent" },
    { id: 15, name: "ai_title" },
    { id: 99, name: "ai_error_message" },
  ],
};

describe("LIFECYCLE_TAGS", () => {
  it("contains six states", () => {
    expect(LIFECYCLE_TAGS.length).toBe(6);
  });

  it("includes all pipeline states", () => {
    expect(new Set(LIFECYCLE_TAGS)).toEqual(
      new Set([
        "ai-pending",
        "ai-approved",
        "ai-rejected",
        "ai-propagated",
        "ai-propagation-error",
        "ai-error",
      ]),
    );
  });
});

describe("setErrorMessage", () => {
  it("writes the message and preserves existing fields", async () => {
    let capturedBody: string | undefined;

    const client = clientWithHandler(({ method, url, body }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "GET" && url.pathname === "/api/documents/42/") {
        return {
          status: 200,
          json: {
            id: 42,
            custom_fields: [
              { field: 1, value: "Rechnung" },
              { field: 2, value: "Stadtwerke" },
            ],
          },
        };
      }
      if (method === "PATCH" && url.pathname === "/api/documents/42/") {
        capturedBody = JSON.stringify(body);
        return { status: 200, json: {} };
      }
      return { status: 404 };
    });

    await client.setErrorMessage(42, "Boom");

    expect(capturedBody).toContain('"field":99');
    expect(capturedBody).toContain('"value":"Boom"');
    // Existing fields must survive the merge.
    expect(capturedBody).toContain('"value":"Rechnung"');
    expect(capturedBody).toContain('"value":"Stadtwerke"');
  });

  it("clears the existing message when null is passed", async () => {
    let capturedBody: string | undefined;

    const client = clientWithHandler(({ method, url, body }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "GET") {
        return {
          status: 200,
          json: {
            id: 42,
            custom_fields: [
              { field: 1, value: "Rechnung" },
              { field: 99, value: "prior failure" },
            ],
          },
        };
      }
      if (method === "PATCH") {
        capturedBody = JSON.stringify(body);
        return { status: 200, json: {} };
      }
      return { status: 404 };
    });

    await client.setErrorMessage(42, null);

    // ai_error_message is dropped, other fields stay.
    expect(capturedBody).not.toContain('"field":99');
    expect(capturedBody).toContain('"value":"Rechnung"');
  });

  it("silently skips when the field is not bootstrapped", async () => {
    const seen: string[] = [];

    const client = clientWithHandler(({ method, url }) => {
      seen.push(`${method} ${url.pathname}`);
      if (url.pathname === "/api/custom_fields/") {
        return { status: 200, json: { results: [{ id: 1, name: "ai_document_type" }] } };
      }
      return { status: 500 }; // would fail the assertion below if hit
    });

    // Must not throw; no document GET/PATCH should occur.
    await client.setErrorMessage(42, "Boom");

    expect(seen).toEqual(["GET /api/custom_fields/"]);
  });

  it("swallows a Paperless 4xx so the caller's failure path continues", async () => {
    const client = clientWithHandler(({ method, url }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "GET") return { status: 200, json: { id: 42, custom_fields: [] } };
      // PATCH rejected — must NOT throw.
      return { status: 400 };
    });

    await expect(client.setErrorMessage(42, "Boom")).resolves.toBeUndefined();
  });
});
