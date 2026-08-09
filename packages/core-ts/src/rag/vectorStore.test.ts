import { describe, expect, it } from "vitest";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Chunk } from "./chunker.js";
import {
  ChunkPayload,
  QdrantVectorStore,
  SearchFilter,
  buildQdrantFilter,
  payloadFromDict,
  payloadToDict,
  pointId,
} from "./vectorStore.js";

// Mirrors services/auto-tagger/tests/test_rag_vector_store.py. Tests inject
// a stub client that records calls and returns scripted responses — no real
// Qdrant container involved. The contract being tested is the wrapper's
// behaviour given a hypothetical Qdrant: that we build the right filters,
// write the right payloads, dedupe by point ID, and parse responses back
// into ChunkPayload correctly.

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
}

class FakeQdrantClient {
  calls: RecordedCall[] = [];
  private collectionExistsValue: boolean;
  private searchPoints: { score: number; payload: Record<string, unknown> }[];
  private chunkCount: number;

  constructor(
    options: {
      collectionExists?: boolean;
      searchPoints?: { score: number; payload: Record<string, unknown> }[];
      chunkCount?: number;
    } = {},
  ) {
    this.collectionExistsValue = options.collectionExists ?? false;
    this.searchPoints = options.searchPoints ?? [];
    this.chunkCount = options.chunkCount ?? 0;
  }

  async collectionExists(name: string): Promise<{ exists: boolean }> {
    this.calls.push({ method: "collectionExists", args: { name } });
    return { exists: this.collectionExistsValue };
  }

  async createCollection(name: string, args: Record<string, unknown>): Promise<boolean> {
    this.calls.push({ method: "createCollection", args: { name, ...args } });
    // Mark as existing so subsequent calls in the same test don't re-create
    // it — matches real Qdrant behaviour.
    this.collectionExistsValue = true;
    return true;
  }

  async createPayloadIndex(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "createPayloadIndex", args: { name, ...args } });
    return {};
  }

  async upsert(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "upsert", args: { name, ...args } });
    return {};
  }

  async delete(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "delete", args: { name, ...args } });
    return {};
  }

  async setPayload(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "setPayload", args: { name, ...args } });
    return {};
  }

  async count(name: string, args: Record<string, unknown>): Promise<{ count: number }> {
    this.calls.push({ method: "count", args: { name, ...args } });
    return { count: this.chunkCount };
  }

  async query(name: string, args: Record<string, unknown>): Promise<{ points: unknown[] }> {
    this.calls.push({ method: "query", args: { name, ...args } });
    return { points: this.searchPoints.map((p) => ({ id: "dummy", version: 0, ...p })) };
  }
}

class ExplodingClient {
  async collectionExists(): Promise<never> {
    throw new Error("connection refused");
  }
}

function makeStore(client?: FakeQdrantClient | ExplodingClient): QdrantVectorStore {
  return new QdrantVectorStore("http://stub", {
    client: (client ?? new FakeQdrantClient()) as unknown as QdrantClient,
  });
}

function callsOf(fake: FakeQdrantClient, method: string): RecordedCall[] {
  return fake.calls.filter((c) => c.method === method);
}

function chunk(idx: number, text = "alpha beta gamma"): Chunk {
  return Object.freeze({
    index: idx,
    text,
    charStart: idx * 100,
    charEnd: idx * 100 + text.length,
    tokenCount: text.split(" ").length,
  });
}

describe("ensureCollection", () => {
  it("creates the collection when missing", async () => {
    const fake = new FakeQdrantClient({ collectionExists: false });
    const store = makeStore(fake);

    await store.ensureCollection();

    expect(fake.calls[0]!.method).toBe("collectionExists");
    const created = callsOf(fake, "createCollection")[0];
    expect(created).toBeDefined();
    expect(created!.args["name"]).toBe("aktenraum_chunks");
    const vectors = created!.args["vectors"] as { size: number; distance: string };
    expect(vectors.size).toBe(2560);
    expect(vectors.distance).toBe("Cosine");
  });

  it("skips create when the collection already exists", async () => {
    const fake = new FakeQdrantClient({ collectionExists: true });
    const store = makeStore(fake);

    await store.ensureCollection();

    expect(callsOf(fake, "createCollection").length).toBe(0);
    // Payload-index calls still happen — they're idempotent and self-heal
    // if a previous deploy added a new index field.
    expect(callsOf(fake, "createPayloadIndex").length).toBeGreaterThan(0);
  });

  it("creates indexes for all filterable fields", async () => {
    const fake = new FakeQdrantClient({ collectionExists: true });
    const store = makeStore(fake);

    await store.ensureCollection();

    const indexedFields = new Set(
      callsOf(fake, "createPayloadIndex").map((c) => c.args["field_name"]),
    );
    expect(indexedFields).toEqual(new Set(["doc_id", "doc_type", "correspondent", "tags"]));
  });

  it("swallows an already-exists error from payload indexing", async () => {
    class AlreadyExistsClient extends FakeQdrantClient {
      override async createPayloadIndex(name: string, args: Record<string, unknown>) {
        this.calls.push({ method: "createPayloadIndex", args: { name, ...args } });
        throw new Error("Index for field doc_id already exists");
      }
    }
    const fake = new AlreadyExistsClient({ collectionExists: true });
    const store = makeStore(fake);

    await expect(store.ensureCollection()).resolves.toBeUndefined();
  });
});

describe("upsertChunks", () => {
  it("writes one point per chunk", async () => {
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    const written = await store.upsertChunks(
      [chunk(0), chunk(1), chunk(2)],
      [Array(2560).fill(0.0), Array(2560).fill(1.0), Array(2560).fill(2.0)],
      {
        docId: 42,
        docType: "Lebenslauf",
        correspondent: "Selbst",
        tags: ["Lebenslauf", "Bewerbung"],
        createdDate: "2024-01-15",
      },
    );

    expect(written).toBe(3);
    const upsertCall = callsOf(fake, "upsert")[0]!;
    const points = upsertCall.args["points"] as { payload: Record<string, unknown> }[];
    expect(points.length).toBe(3);
    // Payload denormalises doc-level metadata onto every chunk so
    // query-time filters can apply at the vector layer.
    expect(points[0]!.payload["doc_id"]).toBe(42);
    expect(points[0]!.payload["doc_type"]).toBe("Lebenslauf");
    expect(points[0]!.payload["correspondent"]).toBe("Selbst");
    expect(points[0]!.payload["tags"]).toEqual(["Lebenslauf", "Bewerbung"]);
    expect(points[0]!.payload["created_date"]).toBe("2024-01-15");
    // The chunk's text is in the payload — no second-fetch needed at query
    // time for the answer LLM.
    expect(points[0]!.payload["text"]).toBe("alpha beta gamma");
  });

  it("uses deterministic point IDs for the same (docId, chunkIndex)", async () => {
    // Critical for idempotent re-indexing: a reprocess must REPLACE
    // existing chunks, not append duplicates.
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    await store.upsertChunks([chunk(7)], [Array(2560).fill(0.0)], { docId: 99 });
    const firstCall = callsOf(fake, "upsert").at(-1)!;
    const firstId = (firstCall.args["points"] as { id: string }[])[0]!.id;

    fake.calls = [];
    await store.upsertChunks([chunk(7)], [Array(2560).fill(0.0)], { docId: 99 });
    const secondCall = callsOf(fake, "upsert").at(-1)!;
    const secondId = (secondCall.args["points"] as { id: string }[])[0]!.id;

    expect(firstId).toBe(secondId);
  });

  it("is a no-op for empty input", async () => {
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    const written = await store.upsertChunks([], [], { docId: 1 });

    expect(written).toBe(0);
    expect(callsOf(fake, "upsert").length).toBe(0);
  });

  it("throws on mismatched chunk/embedding lengths", async () => {
    // Programmer error — surface it loudly rather than silently truncating
    // one or the other.
    const store = makeStore();
    await expect(
      store.upsertChunks([chunk(0)], [Array(2560).fill(0.0), Array(2560).fill(1.0)], {
        docId: 1,
      }),
    ).rejects.toThrow(/must be the same length/);
  });
});

describe("deleteByDocId", () => {
  it("filters on doc_id", async () => {
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    await store.deleteByDocId(42);

    const deleteCall = callsOf(fake, "delete")[0]!;
    const filter = deleteCall.args["filter"] as { must: { key: string; match: { value: number } }[] };
    expect(filter.must.length).toBe(1);
    expect(filter.must[0]!.key).toBe("doc_id");
    expect(filter.must[0]!.match.value).toBe(42);
  });
});

describe("updateMetadataByDocId", () => {
  it("filters on doc_id and sets only metadata fields", async () => {
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    await store.updateMetadataByDocId(42, {
      docType: "Rechnung",
      correspondent: "Telekom",
      tags: ["wichtig"],
      createdDate: "2024-06-15",
    });

    const setCall = callsOf(fake, "setPayload")[0]!;
    expect(setCall.args["name"]).toBe("aktenraum_chunks");
    const payload = setCall.args["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      doc_type: "Rechnung",
      correspondent: "Telekom",
      tags: ["wichtig"],
      created_date: "2024-06-15",
    });
    // Only the four metadata keys are touched — text/chunk position/vector
    // are never part of this payload, unlike a full upsert.
    expect(payload).not.toHaveProperty("text");
    expect(payload).not.toHaveProperty("chunk_index");
    const filter = setCall.args["filter"] as { must: { key: string; match: { value: number } }[] };
    expect(filter.must[0]!.key).toBe("doc_id");
    expect(filter.must[0]!.match.value).toBe(42);
  });

  it("is a no-op (not an error) when no points are indexed for the doc", async () => {
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    await store.updateMetadataByDocId(999, { tags: ["x"] });

    expect(callsOf(fake, "setPayload").length).toBe(1);
  });

  it("serialises missing fields as null", async () => {
    const fake = new FakeQdrantClient();
    const store = makeStore(fake);

    await store.updateMetadataByDocId(7);

    const payload = callsOf(fake, "setPayload")[0]!.args["payload"] as Record<string, unknown>;
    expect(payload["doc_type"]).toBeNull();
    expect(payload["correspondent"]).toBeNull();
    expect(payload["tags"]).toEqual([]);
    expect(payload["created_date"]).toBeNull();
  });
});

describe("search", () => {
  it("passes through the filter and topK, and projects hits back to typed shape", async () => {
    const fake = new FakeQdrantClient({
      searchPoints: [
        {
          score: 0.95,
          payload: {
            doc_id: 17,
            chunk_index: 3,
            text: "Frontend bei Kopfstand seit 2022.",
            char_start: 0,
            char_end: 30,
            token_count: 5,
            doc_type: "Lebenslauf",
            correspondent: "Selbst",
            tags: ["Lebenslauf"],
            created_date: "2024-01-15",
            page: null,
          },
        },
      ],
    });
    const store = makeStore(fake);

    const hits = await store.search(Array(2560).fill(0.5), {
      topK: 10,
      filter: { tags: ["Lebenslauf"], docTypes: ["Lebenslauf"] },
    });

    const queryCall = callsOf(fake, "query")[0]!;
    expect(queryCall.args["limit"]).toBe(10);
    // The composed filter has two MUST conditions (doc_type, tags).
    const qfilter = queryCall.args["filter"] as { must: { key: string }[] };
    const keys = qfilter.must.map((c) => c.key);
    expect(keys).toContain("doc_type");
    expect(keys).toContain("tags");
    // Hits are projected back into our typed shape.
    expect(hits.length).toBe(1);
    expect(hits[0]!.score).toBe(0.95);
    expect(hits[0]!.payload.docId).toBe(17);
    expect(hits[0]!.payload.text).toBe("Frontend bei Kopfstand seit 2022.");
  });

  it("omits the filter when none is given", async () => {
    const fake = new FakeQdrantClient({ searchPoints: [] });
    const store = makeStore(fake);

    await store.search(Array(2560).fill(0.0), { topK: 5 });

    const queryCall = callsOf(fake, "query")[0]!;
    expect(queryCall.args["filter"]).toBeUndefined();
  });
});

describe("countChunksForDoc", () => {
  it("filters on doc_id", async () => {
    // Backfill needs a cheap "is this doc indexed?" probe — pin the filter
    // shape so a refactor can't silently change the where clause.
    const fake = new FakeQdrantClient({ chunkCount: 7 });
    const store = makeStore(fake);

    const count = await store.countChunksForDoc(42);

    expect(count).toBe(7);
    const countCall = callsOf(fake, "count")[0]!;
    expect(countCall.args["name"]).toBe("aktenraum_chunks");
    expect(countCall.args["exact"]).toBe(true);
    const filter = countCall.args["filter"] as { must: { key: string; match: { value: number } }[] };
    expect(filter.must.length).toBe(1);
    expect(filter.must[0]!.key).toBe("doc_id");
    expect(filter.must[0]!.match.value).toBe(42);
  });

  it("returns zero when the doc is not indexed", async () => {
    const store = makeStore(new FakeQdrantClient({ chunkCount: 0 }));
    expect(await store.countChunksForDoc(99)).toBe(0);
  });
});

describe("healthCheck", () => {
  it("is true when the collection exists", async () => {
    const store = makeStore(new FakeQdrantClient({ collectionExists: true }));
    expect(await store.healthCheck()).toBe(true);
  });

  it("is false on exception, never throws", async () => {
    // Health checks must not throw — the desktop shell renders status
    // indicators, not stack traces.
    const store = makeStore(new ExplodingClient());
    expect(await store.healthCheck()).toBe(false);
  });
});

describe("pointId", () => {
  it("is deterministic per (docId, chunkIndex) pair", () => {
    const a = pointId(99, 0);
    const b = pointId(99, 0);
    const c = pointId(99, 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("matches the namespace pinned on the Python side", () => {
    // Sentinel: regenerating the namespace UUID would orphan every
    // existing chunk in production. This value is copied verbatim from
    // test_rag_vector_store.py's test_point_id_namespace_pinned — it also
    // doubles as a cross-language parity check that this port's UUID5
    // computation matches Python's uuid.uuid5 byte-for-byte.
    const expected = "9c9fc3cd-97ef-5de0-ae76-d3dfee216087";
    expect(pointId(0, 0)).toBe(expected);
  });
});

describe("payload round-trip", () => {
  it("preserves all fields", () => {
    const p: ChunkPayload = {
      docId: 42,
      chunkIndex: 3,
      text: "hello",
      charStart: 0,
      charEnd: 5,
      tokenCount: 1,
      docType: "Rechnung",
      correspondent: "Telekom",
      tags: ["Telekom", "Mobilfunk"],
      createdDate: "2024-06-15",
      page: 2,
    };
    const raw = payloadToDict(p);
    const restored = payloadFromDict(raw);
    expect(restored).toEqual(p);
  });

  it("tolerates missing fields (older, smaller schema)", () => {
    const restored = payloadFromDict({ doc_id: 1, chunk_index: 0, text: "x" });
    expect(restored.docId).toBe(1);
    expect(restored.tags).toEqual([]);
    expect(restored.createdDate).toBeNull();
  });

  it("is frozen", () => {
    const restored = payloadFromDict({ doc_id: 1, chunk_index: 0, text: "x" });
    expect(() => {
      // @ts-expect-error — intentionally mutating a frozen object for the test
      restored.text = "y";
    }).toThrow();
  });
});

describe("buildQdrantFilter", () => {
  it("combines fields with MUST", () => {
    const f: SearchFilter = {
      docTypes: ["Rechnung"],
      correspondents: ["Telekom"],
      tags: ["wichtig"],
    };
    const qfilter = buildQdrantFilter(f);
    expect(qfilter.must.map((c) => c.key)).toEqual(["doc_type", "correspondent", "tags"]);
  });

  it("uses MatchAny (OR) within a single field", () => {
    // Multiple values in one field OR together; different fields AND
    // together (MUST). Test the OR side here.
    const f: SearchFilter = { tags: ["Lebenslauf", "Bewerbung"] };
    const qfilter = buildQdrantFilter(f);
    const cond = qfilter.must[0]!;
    expect(cond.match).toEqual({ any: ["Lebenslauf", "Bewerbung"] });
  });
});
