import { describe, expect, it } from "vitest";

import {
  PaperlessAuthError,
  PaperlessConflictError,
  PaperlessNotFoundError,
} from "./errors.js";
import {
  mergeCustomFields,
  normaliseFieldValues,
  PaperlessGateway,
  planTagSwap,
  type CustomFieldEntry,
} from "./paperless.gateway.js";

interface RecordedRequest {
  method: string;
  url: URL;
  body?: unknown;
}

type Handler = (req: RecordedRequest) => { status: number; json?: unknown; text?: string };

function gatewayWithHandler(handler: Handler): {
  gateway: PaperlessGateway;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : undefined;
    const req = { method: (init?.method ?? "GET").toUpperCase(), url, body };
    requests.push(req);
    const result = handler(req);
    const payload =
      result.text !== undefined
        ? result.text
        : result.json !== undefined
          ? JSON.stringify(result.json)
          : "";
    return new Response(payload, { status: result.status });
  }) as typeof fetch;

  return {
    gateway: new PaperlessGateway("http://paperless.test", "tok", { fetchFn }),
    requests,
  };
}

const TAGS_PAGE = {
  results: [
    { id: 1, name: "ai-pending" },
    { id: 2, name: "ai-approved" },
    { id: 4, name: "ai-low-confidence" },
    { id: 5, name: "wichtig" },
  ],
};

const CUSTOM_FIELDS_PAGE = {
  results: [
    { id: 10, name: "ai_correspondent" },
    { id: 11, name: "ai_document_type" },
    { id: 13, name: "ai_issue_date" },
    { id: 14, name: "ai_confidence" },
    { id: 15, name: "ai_summary_de" },
  ],
};

describe("mergeCustomFields", () => {
  it("overwrites targeted ids and preserves every untouched entry", () => {
    const existing: CustomFieldEntry[] = [
      { field: 10, value: "Alt" },
      { field: 11, value: "Rechnung" },
      { field: 15, value: "Zusammenfassung" },
    ];
    const merged = mergeCustomFields(existing, new Map([[10, "Neu"]]));
    expect(merged).toEqual([
      { field: 10, value: "Neu" },
      { field: 11, value: "Rechnung" },
      { field: 15, value: "Zusammenfassung" },
    ]);
  });

  it("appends updates for ids not currently on the document", () => {
    const merged = mergeCustomFields([{ field: 10, value: "Alt" }], new Map([[13, "2026-03-15"]]));
    expect(merged).toEqual([
      { field: 10, value: "Alt" },
      { field: 13, value: "2026-03-15" },
    ]);
  });

  it("drops existing entries that carry no field id", () => {
    const existing = [{ value: "orphan" }, { field: 10, value: "Alt" }] as CustomFieldEntry[];
    expect(mergeCustomFields(existing, new Map())).toEqual([{ field: 10, value: "Alt" }]);
  });

  it("writes an explicit null rather than dropping the field", () => {
    expect(mergeCustomFields([{ field: 10, value: "Alt" }], new Map([[10, null]]))).toEqual([
      { field: 10, value: null },
    ]);
  });
});

describe("planTagSwap", () => {
  const nameToId = { "ai-pending": 1, "ai-approved": 2, "ai-low-confidence": 4, wichtig: 5 };

  it("removes named tags and appends the new one, preserving survivor order", () => {
    expect(
      planTagSwap({
        currentIds: [1, 4, 5],
        nameToId,
        remove: ["ai-pending", "ai-low-confidence"],
        add: ["ai-approved"],
      }),
    ).toEqual([5, 2]);
  });

  it("is a no-op when the tag to add is already present", () => {
    expect(
      planTagSwap({ currentIds: [5, 2], nameToId, remove: ["ai-pending"], add: ["ai-approved"] }),
    ).toEqual([5, 2]);
  });

  it("ignores names that do not exist in Paperless", () => {
    expect(
      planTagSwap({ currentIds: [5], nameToId, remove: ["gibtsnicht"], add: ["auchnicht"] }),
    ).toEqual([5]);
  });

  it("never duplicates an id listed twice in add", () => {
    expect(
      planTagSwap({ currentIds: [], nameToId, remove: [], add: ["ai-approved", "ai-approved"] }),
    ).toEqual([2]);
  });
});

describe("normaliseFieldValues", () => {
  it("normalises German dates to strict ISO", () => {
    expect(normaliseFieldValues({ ai_issue_date: "15.03.2026" })).toEqual({
      ai_issue_date: "2026-03-15",
    });
  });

  it("drops an unparseable date rather than failing the whole patch", () => {
    expect(normaliseFieldValues({ ai_issue_date: "irgendwann" })).toEqual({
      ai_issue_date: null,
    });
  });

  it("passes floats through untouched", () => {
    expect(normaliseFieldValues({ ai_confidence: 0.87 })).toEqual({ ai_confidence: 0.87 });
  });

  it("truncates a string field at Paperless's 128-char limit", () => {
    const long = "a".repeat(200);
    const out = normaliseFieldValues({ ai_correspondent: long }).ai_correspondent as string;
    expect(out).toHaveLength(128);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves longtext fields at full length", () => {
    const long = "b".repeat(200);
    expect(normaliseFieldValues({ ai_summary_de: long }).ai_summary_de).toBe(long);
  });

  it("passes null through instead of coercing it to a string", () => {
    expect(normaliseFieldValues({ ai_title: null })).toEqual({ ai_title: null });
  });
});

describe("patchDocumentCustomFields", () => {
  it("sends the merged array so untouched fields survive the full-array replace", async () => {
    let patched: unknown;
    const { gateway } = gatewayWithHandler(({ method, url, body }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "GET" && url.pathname === "/api/documents/42/") {
        return {
          status: 200,
          json: {
            id: 42,
            custom_fields: [
              { field: 10, value: "Stadtwerke" },
              { field: 11, value: "Rechnung" },
              { field: 15, value: "Zusammenfassung" },
            ],
          },
        };
      }
      if (method === "PATCH" && url.pathname === "/api/documents/42/") {
        patched = body;
        return { status: 200, json: { id: 42 } };
      }
      return { status: 404 };
    });

    await gateway.patchDocumentCustomFields(42, { ai_document_type: "Mahnung" });

    expect(patched).toEqual({
      custom_fields: [
        { field: 10, value: "Stadtwerke" },
        { field: 11, value: "Mahnung" },
        { field: 15, value: "Zusammenfassung" },
      ],
    });
  });

  it("refetches the custom-field ids once when a name is missing from the cache", async () => {
    let customFieldCalls = 0;
    const { gateway } = gatewayWithHandler(({ method, url }) => {
      if (url.pathname === "/api/custom_fields/") {
        customFieldCalls += 1;
        return customFieldCalls === 1
          ? { status: 200, json: { results: [{ id: 10, name: "ai_correspondent" }] } }
          : { status: 200, json: CUSTOM_FIELDS_PAGE };
      }
      if (method === "GET" && url.pathname === "/api/documents/42/") {
        return { status: 200, json: { id: 42, custom_fields: [] } };
      }
      if (method === "PATCH") return { status: 200, json: { id: 42 } };
      return { status: 404 };
    });

    await gateway.patchDocumentCustomFields(42, { ai_summary_de: "Text" });

    expect(customFieldCalls).toBe(2);
  });

  it("skips an unknown field instead of failing the patch", async () => {
    let patchCalls = 0;
    const { gateway } = gatewayWithHandler(({ method, url }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "GET" && url.pathname === "/api/documents/42/") {
        return { status: 200, json: { id: 42, custom_fields: [] } };
      }
      if (method === "PATCH") {
        patchCalls += 1;
        return { status: 200, json: { id: 42 } };
      }
      return { status: 404 };
    });

    const result = await gateway.patchDocumentCustomFields(42, { ai_nonexistent: "x" });

    expect(patchCalls).toBe(0);
    expect(result).toEqual({ ai_nonexistent: "x" });
  });

  it("makes no request at all for an empty update", async () => {
    const { gateway, requests } = gatewayWithHandler(() => ({ status: 500 }));
    expect(await gateway.patchDocumentCustomFields(42, {})).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("uses the prefetched document instead of re-reading it", async () => {
    const { gateway, requests } = gatewayWithHandler(({ method, url }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "PATCH") return { status: 200, json: { id: 42 } };
      return { status: 500 };
    });

    await gateway.patchDocumentCustomFields(
      42,
      { ai_document_type: "Mahnung" },
      { prefetchedDoc: { id: 42, custom_fields: [{ field: 11, value: "Rechnung" }] } },
    );

    expect(requests.filter((r) => r.method === "GET" && r.url.pathname === "/api/documents/42/")).toHaveLength(0);
  });

  it("raises PaperlessNotFoundError when the document disappeared", async () => {
    const { gateway } = gatewayWithHandler(({ method, url }) => {
      if (url.pathname === "/api/custom_fields/") return { status: 200, json: CUSTOM_FIELDS_PAGE };
      if (method === "GET" && url.pathname === "/api/documents/42/") return { status: 404 };
      return { status: 500 };
    });

    await expect(
      gateway.patchDocumentCustomFields(42, { ai_document_type: "Mahnung" }),
    ).rejects.toBeInstanceOf(PaperlessNotFoundError);
  });
});

describe("swapLifecycleTag", () => {
  function docServer(options: {
    initialTags: number[];
    onPatch?: (tags: number[], attempt: number) => number[];
  }) {
    let tags = [...options.initialTags];
    let attempt = 0;
    const { gateway, requests } = gatewayWithHandler(({ method, url, body }) => {
      if (url.pathname === "/api/tags/") return { status: 200, json: TAGS_PAGE };
      if (method === "GET" && url.pathname === "/api/documents/42/") {
        return { status: 200, json: { id: 42, tags } };
      }
      if (method === "PATCH" && url.pathname === "/api/documents/42/") {
        attempt += 1;
        const written = (body as { tags: number[] }).tags;
        tags = options.onPatch ? options.onPatch(written, attempt) : written;
        return { status: 200, json: { id: 42, tags } };
      }
      return { status: 404 };
    });
    return { gateway, requests, currentTags: () => tags };
  }

  it("swaps pending for approved and leaves unrelated tags alone", async () => {
    const { gateway, currentTags } = docServer({ initialTags: [1, 4, 5] });
    const result = await gateway.swapLifecycleTag(42, {
      remove: ["ai-pending", "ai-low-confidence"],
      add: ["ai-approved"],
    });
    expect(result).toEqual([5, 2]);
    expect(currentTags()).toEqual([5, 2]);
  });

  it("issues no PATCH when the swap would change nothing", async () => {
    const { gateway, requests } = docServer({ initialTags: [5, 2] });
    const result = await gateway.swapLifecycleTag(42, {
      remove: ["ai-pending"],
      add: ["ai-approved"],
    });
    expect(result).toEqual([5, 2]);
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("replays the swap when a concurrent writer undid it, then succeeds", async () => {
    const { gateway, requests } = docServer({
      initialTags: [1, 5],
      onPatch: (written, attempt) => (attempt === 1 ? [...written, 1] : written),
    });

    const result = await gateway.swapLifecycleTag(42, {
      remove: ["ai-pending"],
      add: ["ai-approved"],
    });

    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
    expect(result).toEqual([5, 2]);
  });

  it("accepts a concurrent addition that does not conflict, without a second PATCH", async () => {
    const { gateway, requests } = docServer({
      initialTags: [1, 5],
      onPatch: (written, attempt) => (attempt === 1 ? [...written, 99] : written),
    });

    const result = await gateway.swapLifecycleTag(42, {
      remove: ["ai-pending"],
      add: ["ai-approved"],
    });

    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(result).toEqual([5, 2, 99]);
  });

  it("raises PaperlessConflictError when three attempts all race", async () => {
    const { gateway, requests } = docServer({
      initialTags: [1, 5],
      onPatch: (written) => [...written, 1],
    });

    await expect(
      gateway.swapLifecycleTag(42, { remove: ["ai-pending"], add: ["ai-approved"] }),
    ).rejects.toBeInstanceOf(PaperlessConflictError);
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(3);
  });

  it("treats a reordered read-back as success rather than a race", async () => {
    const { gateway, requests } = docServer({
      initialTags: [1, 5],
      onPatch: (written) => [...written].reverse(),
    });

    await gateway.swapLifecycleTag(42, { remove: ["ai-pending"], add: ["ai-approved"] });

    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
});

describe("ensureTag", () => {
  it("returns the cached id without any lookup", async () => {
    const { gateway, requests } = gatewayWithHandler(({ url }) => {
      if (url.pathname === "/api/tags/") return { status: 200, json: TAGS_PAGE };
      return { status: 500 };
    });
    expect(await gateway.ensureTag("wichtig")).toBe(5);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("creates the tag when it genuinely does not exist", async () => {
    const { gateway, requests } = gatewayWithHandler(({ method, url }) => {
      if (method === "GET" && url.pathname === "/api/tags/") {
        return url.searchParams.has("name__iexact")
          ? { status: 200, json: { results: [] } }
          : { status: 200, json: TAGS_PAGE };
      }
      if (method === "POST" && url.pathname === "/api/tags/") {
        return { status: 201, json: { id: 77 } };
      }
      return { status: 500 };
    });

    expect(await gateway.ensureTag("neu")).toBe(77);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("recovers the id when a parallel create won the race", async () => {
    const { gateway } = gatewayWithHandler(({ method, url }) => {
      if (method === "GET" && url.pathname === "/api/tags/") {
        if (!url.searchParams.has("name__iexact")) return { status: 200, json: TAGS_PAGE };
        return { status: 200, json: { results: [] } };
      }
      if (method === "POST" && url.pathname === "/api/tags/") return { status: 400 };
      return { status: 500 };
    });

    await expect(gateway.ensureTag("neu")).rejects.toThrow();
  });

  it("uses the case-insensitive lookup before creating", async () => {
    const { gateway, requests } = gatewayWithHandler(({ method, url }) => {
      if (method === "GET" && url.pathname === "/api/tags/") {
        return url.searchParams.has("name__iexact")
          ? { status: 200, json: { results: [{ id: 88, name: "neu" }] } }
          : { status: 200, json: TAGS_PAGE };
      }
      return { status: 500 };
    });

    expect(await gateway.ensureTag("neu")).toBe(88);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});

describe("error mapping", () => {
  it("maps 404 on getDocument to PaperlessNotFoundError", async () => {
    const { gateway } = gatewayWithHandler(() => ({ status: 404 }));
    await expect(gateway.getDocument(9)).rejects.toBeInstanceOf(PaperlessNotFoundError);
  });

  it("maps 401 to PaperlessAuthError", async () => {
    const { gateway } = gatewayWithHandler(() => ({ status: 401 }));
    await expect(gateway.getDocument(9)).rejects.toBeInstanceOf(PaperlessAuthError);
  });

  it("maps 403 on a search to PaperlessAuthError", async () => {
    const { gateway } = gatewayWithHandler(() => ({ status: 403 }));
    await expect(gateway.searchDocuments({})).rejects.toBeInstanceOf(PaperlessAuthError);
  });
});

describe("entity caches", () => {
  it("serves repeat tag lookups from the per-process cache", async () => {
    const { gateway, requests } = gatewayWithHandler(() => ({ status: 200, json: TAGS_PAGE }));
    await gateway.listTags();
    await gateway.listTags();
    expect(requests).toHaveLength(1);
  });

  it("expires the cache once the TTL has passed", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify(TAGS_PAGE), { status: 200 });
    }) as typeof fetch;
    const gateway = new PaperlessGateway("http://paperless.test", "tok", {
      fetchFn,
      ttlSeconds: -1,
    });
    await gateway.listTags();
    await gateway.listTags();
    expect(calls).toBe(2);
  });
});

describe("listTagsCovering", () => {
  function tagServer(pages: { results: { id: number; name: string }[] }[]) {
    let call = 0;
    const { gateway, requests } = gatewayWithHandler(({ url }) => {
      if (url.pathname === "/api/tags/") {
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return { status: 200, json: page };
      }
      return { status: 404 };
    });
    return { gateway, requests };
  }

  it("serves from cache when every id is already known", async () => {
    const { gateway, requests } = tagServer([TAGS_PAGE]);
    await gateway.listTagsCovering([1, 5]);
    expect(requests).toHaveLength(1);
  });

  it("refetches once when a tag id is missing from the cached map", async () => {
    const fresh = { results: [...TAGS_PAGE.results, { id: 99, name: "frisch-propagiert" }] };
    const { gateway, requests } = tagServer([TAGS_PAGE, fresh]);

    const mapping = await gateway.listTagsCovering([1, 99]);

    expect(requests).toHaveLength(2);
    expect(mapping["frisch-propagiert"]).toBe(99);
  });

  it("does not refetch on every call for a tag that genuinely does not exist", async () => {
    const { gateway, requests } = tagServer([TAGS_PAGE]);
    await gateway.listTagsCovering([12345]);
    const afterFirst = requests.length;
    await gateway.listTagsCovering([12345]);
    expect(requests.length - afterFirst).toBe(1);
  });

  it("tolerates an empty id list", async () => {
    const { gateway, requests } = tagServer([TAGS_PAGE]);
    expect(await gateway.listTagsCovering([])).toEqual({
      "ai-pending": 1,
      "ai-approved": 2,
      "ai-low-confidence": 4,
      wichtig: 5,
    });
    expect(requests).toHaveLength(1);
  });
});
