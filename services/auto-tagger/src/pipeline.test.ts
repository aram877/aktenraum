import { describe, expect, it, vi } from "vitest";
import type {
  DocumentExtraction,
  Embedder,
  LLMBackend,
  PaperlessClient,
  PaperlessDocument,
  QdrantVectorStore,
} from "@aktenraum/core";

import { ActiveModelConfig } from "./active-model.js";
import { parseRuleSet } from "./auto-approve-config.js";
import { loadSettings } from "./config.js";
import { processDocument } from "./extract.js";
import {
  enqueueUnindexedDocuments,
  indexDocument,
  INDEX_ERROR_TAG,
  reindexMetadata,
  type IndexJob,
} from "./indexer.js";
import { processApprovedDocument } from "./propagate.js";
import type { RuleSet } from "./routing.js";
import { isTransientLlmError, TransientFailureTracker } from "./transient.js";
import { apiTypeFieldsSaver } from "./type-fields.js";

class FakePaperless {
  readonly docs = new Map<number, PaperlessDocument>();
  readonly tagIds = new Map<string, number>();
  readonly patches: { docId: number; fields: Record<string, unknown> }[] = [];
  private nextTagId = 100;

  constructor(initialTags: string[] = []) {
    for (const name of initialTags) this.tagIds.set(name, this.nextTagId++);
  }

  addDoc(doc: Partial<PaperlessDocument> & { id: number }): PaperlessDocument {
    const full = { tags: [], content: "Text", custom_fields: [], ...doc } as PaperlessDocument;
    this.docs.set(doc.id, full);
    return full;
  }

  tagsOf(docId: number): string[] {
    const ids = (this.docs.get(docId)?.tags as number[]) ?? [];
    const byId = new Map([...this.tagIds].map(([n, i]) => [i, n]));
    return ids.map((id) => byId.get(id) ?? String(id));
  }

  async getDocument(docId: number): Promise<PaperlessDocument> {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`no doc ${docId}`);
    return structuredClone(doc);
  }

  async getDocumentContent(docId: number): Promise<string> {
    return ((await this.getDocument(docId)).content as string) ?? "";
  }

  async getTagId(name: string): Promise<number | null> {
    return this.tagIds.get(name) ?? null;
  }

  async getOrCreateTag(name: string): Promise<number> {
    if (!this.tagIds.has(name)) this.tagIds.set(name, this.nextTagId++);
    return this.tagIds.get(name) as number;
  }

  async addTagToDocument(docId: number, name: string): Promise<void> {
    const id = await this.getOrCreateTag(name);
    const doc = this.docs.get(docId) as PaperlessDocument;
    const tags = doc.tags as number[];
    if (!tags.includes(id)) doc.tags = [...tags, id];
  }

  async patchDocumentNativeFields(docId: number, fields: Record<string, unknown>): Promise<void> {
    this.patches.push({ docId, fields });
    const doc = this.docs.get(docId) as PaperlessDocument;
    if (Array.isArray(fields.tags)) doc.tags = fields.tags;
  }

  readonly patchDocumentAiFields = vi.fn(async () => undefined);
  readonly setErrorMessage = vi.fn(async () => undefined);

  async getAiCustomFieldValues(): Promise<Record<string, unknown>> {
    return { ai_document_type: "Rechnung" };
  }

  async getOrCreateCorrespondent(): Promise<number> {
    return 7;
  }

  async getOrCreateDocumentType(): Promise<number> {
    return 8;
  }

  async getDocumentsWithTag(
    name: string,
    batchSize = 5,
    _ordering?: string,
    extra?: Record<string, unknown>,
  ): Promise<PaperlessDocument[]> {
    const id = this.tagIds.get(name);
    if (id === undefined) return [];
    const all = [...this.docs.values()].filter((d) => (d.tags as number[]).includes(id));
    const page = Number(extra?.page ?? 1);
    return all.slice((page - 1) * batchSize, page * batchSize);
  }

  async getCustomFieldNameById(): Promise<Record<number, string>> {
    return {};
  }

  async getEntityNameMap(): Promise<Record<number, string>> {
    return Object.fromEntries([...this.tagIds].map(([n, i]) => [i, n]));
  }

  asClient(): PaperlessClient {
    return this as unknown as PaperlessClient;
  }
}

const EXTRACTION: DocumentExtraction = {
  document_type: "Rechnung",
  correspondent: "Stadtwerke",
  ai_title: "Stromrechnung",
  key_dates: { issue: "2026-03-15" },
  reference_numbers: ["RE-1"],
  suggested_tags: ["Strom"],
  summary_de: "Eine Rechnung.",
  confidence: 0.9,
  confidence_reason: "Klar",
} as DocumentExtraction;

const RULES: RuleSet = parseRuleSet([]);

function settings() {
  return {
    ...loadSettings({ PAPERLESS_BASE_URL: "http://p", PAPERLESS_API_TOKEN: "t" }),
    USE_CORRESPONDENT_HISTORY: false,
  };
}

function backend(complete: LLMBackend["complete"]): LLMBackend {
  return {
    name: "ollama",
    model: "m",
    complete,
    streamText: async function* () {},
  };
}

function connectionRefused(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  return new TypeError("fetch failed", { cause });
}

describe("processDocument", () => {
  it("defers a transient LLM failure without tagging, then gives up after the third", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1 });
    const tracker = new TransientFailureTracker(3);
    const deps = {
      paperless: paperless.asClient(),
      backend: backend(async () => {
        throw connectionRefused();
      }),
      settings: settings(),
      getRules: async () => RULES,
      transientFailures: tracker,
    };

    await processDocument(await paperless.getDocument(1), deps);
    await processDocument(await paperless.getDocument(1), deps);
    expect(paperless.tagsOf(1)).toEqual([]);

    await processDocument(await paperless.getDocument(1), deps);
    expect(paperless.tagsOf(1)).toEqual(["ai-error"]);
    expect(paperless.setErrorMessage).toHaveBeenCalledTimes(1);
  });

  it("tags ai-error immediately on a permanent failure", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1 });
    await processDocument(await paperless.getDocument(1), {
      paperless: paperless.asClient(),
      backend: backend(async () => {
        throw Object.assign(new Error("model not found"), { status_code: 404 });
      }),
      settings: settings(),
      getRules: async () => RULES,
      transientFailures: new TransientFailureTracker(3),
    });
    expect(paperless.tagsOf(1)).toEqual(["ai-error"]);
  });

  it("keeps a tag the user added while the LLM call was running", async () => {
    const paperless = new FakePaperless(["wichtig"]);
    paperless.addDoc({ id: 1 });
    const snapshot = await paperless.getDocument(1);
    await processDocument(snapshot, {
      paperless: paperless.asClient(),
      backend: backend(async () => {
        await paperless.addTagToDocument(1, "wichtig");
        return EXTRACTION as never;
      }),
      settings: settings(),
      getRules: async () => RULES,
    });
    expect(paperless.tagsOf(1)).toEqual(["wichtig", "ai-pending"]);
  });
});

describe("processApprovedDocument", () => {
  it("does nothing for a document that is no longer ai-approved", async () => {
    const paperless = new FakePaperless(["ai-approved", "ai-propagated"]);
    const doc = paperless.addDoc({ id: 1, tags: [paperless.tagIds.get("ai-propagated")] });
    const queue = { push: vi.fn() };

    await processApprovedDocument(doc, paperless.asClient(), { indexingQueue: queue as never });

    expect(paperless.patches).toEqual([]);
    expect(queue.push).not.toHaveBeenCalled();
  });

  it("propagates an approved document and hands it to the indexer", async () => {
    const paperless = new FakePaperless(["ai-approved"]);
    const doc = paperless.addDoc({ id: 1, tags: [paperless.tagIds.get("ai-approved")] });
    const queue = { push: vi.fn() };

    await processApprovedDocument(doc, paperless.asClient(), { indexingQueue: queue as never });

    expect(paperless.tagsOf(1)).toEqual(["ai-propagated"]);
    expect(queue.push).toHaveBeenCalledWith({ kind: "full", docId: 1 });
  });
});

function fakeVectorStore(chunks: number) {
  return {
    deleteByDocId: vi.fn(async () => undefined),
    upsertChunks: vi.fn(async () => 1),
    countChunksForDoc: vi.fn(async () => chunks),
    updateMetadataByDocId: vi.fn(async () => undefined),
  };
}

function embedder(embedDense: Embedder["embedDense"]): Embedder {
  return { model: "e", denseDim: 3, embedDense };
}

describe("indexDocument", () => {
  it("keeps the existing chunks when embedding fails", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1, content: "Ein Absatz mit Text." });
    const store = fakeVectorStore(4);

    await indexDocument(1, {
      paperless: paperless.asClient(),
      vectorStore: store as unknown as QdrantVectorStore,
      embedder: embedder(async () => {
        throw connectionRefused();
      }),
    });

    expect(store.deleteByDocId).not.toHaveBeenCalled();
    expect(paperless.tagsOf(1)).toEqual([INDEX_ERROR_TAG]);
  });

  it("replaces chunks after a successful embed", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1, content: "Ein Absatz mit Text." });
    const store = fakeVectorStore(0);

    await indexDocument(1, {
      paperless: paperless.asClient(),
      vectorStore: store as unknown as QdrantVectorStore,
      embedder: embedder(async (texts) => texts.map(() => [0, 0, 1])),
    });

    expect(store.deleteByDocId).toHaveBeenCalledWith(1);
    expect(store.upsertChunks).toHaveBeenCalledTimes(1);
  });
});

describe("reindexMetadata", () => {
  it("updates the payload without re-embedding when chunks exist", async () => {
    const paperless = new FakePaperless(["wichtig"]);
    paperless.addDoc({ id: 1, tags: [paperless.tagIds.get("wichtig")] });
    const store = fakeVectorStore(3);
    const embed = vi.fn(async () => [[0]]);

    await reindexMetadata(1, {
      paperless: paperless.asClient(),
      vectorStore: store as unknown as QdrantVectorStore,
      embedder: embedder(embed),
    });

    expect(embed).not.toHaveBeenCalled();
    expect(store.deleteByDocId).not.toHaveBeenCalled();
    expect(store.updateMetadataByDocId).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ tags: ["wichtig"] }),
    );
  });

  it("falls back to a full index when nothing is indexed yet", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1, content: "Ein Absatz mit Text." });
    const store = fakeVectorStore(0);

    await reindexMetadata(1, {
      paperless: paperless.asClient(),
      vectorStore: store as unknown as QdrantVectorStore,
      embedder: embedder(async (texts) => texts.map(() => [1])),
    });

    expect(store.upsertChunks).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueUnindexedDocuments", () => {
  it("enqueues every propagated document with no chunks, across pages", async () => {
    const paperless = new FakePaperless(["ai-propagated"]);
    const tag = paperless.tagIds.get("ai-propagated");
    for (const id of [1, 2, 3]) paperless.addDoc({ id, tags: [tag] });
    const store = {
      countChunksForDoc: vi.fn(async (id: number) => (id === 2 ? 5 : 0)),
    };
    const jobs: IndexJob[] = [];

    const count = await enqueueUnindexedDocuments(
      paperless.asClient(),
      store as unknown as QdrantVectorStore,
      { push: (job) => jobs.push(job) },
      2,
    );

    expect(count).toBe(2);
    expect(jobs).toEqual([
      { kind: "full", docId: 1 },
      { kind: "full", docId: 3 },
    ]);
  });
});

describe("isTransientLlmError", () => {
  it("classifies connection, timeout and 5xx/429 failures as transient", () => {
    expect(isTransientLlmError(connectionRefused())).toBe(true);
    expect(isTransientLlmError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isTransientLlmError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransientLlmError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
  });

  it("classifies validation and 4xx failures as permanent", () => {
    expect(isTransientLlmError(new SyntaxError("bad json"))).toBe(false);
    expect(isTransientLlmError(Object.assign(new Error("x"), { status_code: 404 }))).toBe(false);
  });
});

describe("parseRuleSet", () => {
  it("disables a rule whose threshold is missing or not a number", () => {
    const rules = parseRuleSet([
      { document_type: "Rechnung", enabled: true, min_confidence: null },
      { document_type: "Beleg", enabled: true, min_confidence: "abc" },
      { document_type: "Vertrag", enabled: true, min_confidence: 0.8 },
    ]);
    expect(rules.byType.get("Rechnung")?.enabled).toBe(false);
    expect(rules.byType.get("Beleg")?.enabled).toBe(false);
    expect(rules.byType.get("Vertrag")).toMatchObject({ enabled: true, minConfidence: 0.8 });
  });
});

describe("ActiveModelConfig", () => {
  const ok = (model: string) =>
    (async () => new Response(JSON.stringify({ ollama_model: model }))) as unknown as typeof fetch;

  it("returns the model from the api and caches it", async () => {
    const fetchFn = vi.fn(ok("qwen2.5:14b"));
    const config = new ActiveModelConfig("http://api", "s", "env-model", fetchFn);
    expect(await config.getModel(0)).toBe("qwen2.5:14b");
    expect(await config.getModel(30)).toBe("qwen2.5:14b");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the env model on a cold failure", async () => {
    const failing = (async () => {
      throw connectionRefused();
    }) as unknown as typeof fetch;
    const config = new ActiveModelConfig("http://api", "s", "env-model", failing);
    expect(await config.getModel(0)).toBe("env-model");
  });

  it("keeps the last good model when the api blips", async () => {
    let up = true;
    const fetchFn = (async () => {
      if (!up) throw connectionRefused();
      return new Response(JSON.stringify({ ollama_model: "db-model" }));
    }) as unknown as typeof fetch;
    const config = new ActiveModelConfig("http://api", "s", "env-model", fetchFn);
    expect(await config.getModel(0)).toBe("db-model");
    up = false;
    expect(await config.getModel(120)).toBe("db-model");
  });
});

describe("type-specific pass", () => {
  function twoPassBackend(typeFields: Record<string, unknown> | Error) {
    const calls: unknown[] = [];
    return {
      calls,
      backend: backend(async (messages) => {
        calls.push(messages);
        if (calls.length === 1) return EXTRACTION as never;
        if (typeFields instanceof Error) throw typeFields;
        return typeFields as never;
      }),
    };
  }

  it("saves the non-empty type fields after routing", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1 });
    const { backend: llm } = twoPassBackend({ gesamtbetrag: "21,42 EUR", iban: null, rechnungsnummer: "R-1" });
    const save = vi.fn(async () => undefined);

    await processDocument(await paperless.getDocument(1), {
      paperless: paperless.asClient(),
      backend: llm,
      settings: settings(),
      getRules: async () => RULES,
      saveTypeFields: save,
    });

    expect(save).toHaveBeenCalledWith(1, "Rechnung", { gesamtbetrag: "21,42 EUR", rechnungsnummer: "R-1" });
    expect(paperless.tagsOf(1)).toEqual(["ai-pending"]);
  });

  it("is non-fatal when the second LLM call fails", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1 });
    const { backend: llm } = twoPassBackend(new Error("boom"));
    const save = vi.fn(async () => undefined);

    await processDocument(await paperless.getDocument(1), {
      paperless: paperless.asClient(),
      backend: llm,
      settings: settings(),
      getRules: async () => RULES,
      saveTypeFields: save,
    });

    expect(save).not.toHaveBeenCalled();
    expect(paperless.tagsOf(1)).toEqual(["ai-pending"]);
  });

  it("skips Sonstiges, which has no type fields", async () => {
    const paperless = new FakePaperless();
    paperless.addDoc({ id: 1 });
    const calls: unknown[] = [];
    const llm = backend(async () => {
      calls.push(1);
      return { ...EXTRACTION, document_type: "Sonstiges" } as never;
    });

    await processDocument(await paperless.getDocument(1), {
      paperless: paperless.asClient(),
      backend: llm,
      settings: settings(),
      getRules: async () => RULES,
      saveTypeFields: vi.fn(async () => undefined),
    });

    expect(calls).toHaveLength(1);
  });

  it("PATCHes the api with the shared secret", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await apiTypeFieldsSaver("http://api:8002/", "s3cret", fetchFn as unknown as typeof fetch)(7, "Rechnung", {
      gesamtbetrag: "EUR1.00",
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api:8002/api/documents/7/type-fields");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["X-Aktenraum-Secret"]).toBe("s3cret");
    expect(JSON.parse(String(init.body))).toEqual({ document_type: "Rechnung", fields: { gesamtbetrag: "EUR1.00" } });
  });
});
