import type { PaperlessClient, PaperlessDocument } from "@aktenraum/core";
import { describe, expect, it, vi } from "vitest";

import { buildFewShotBlock } from "./prompt.js";
import { findDuplicateIds } from "./propagate.js";
import { apiSpaceLookup, corpusScope, type SpaceLookup } from "./space-lookup.js";

function fetchReturning(status: number, body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

describe("apiSpaceLookup", () => {
  it("returns the space and its peers", async () => {
    const fetchFn = fetchReturning(200, {
      document_id: 5,
      space_id: 2,
      shared_with: [],
      space_document_ids: [4, 5],
    });
    const space = await apiSpaceLookup("http://api/", "s", fetchFn as unknown as typeof fetch)(5);
    expect(space).toEqual({ spaceId: 2, sharedWith: [], peers: new Set([4, 5]) });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://api/api/tenancy/documents/5/space");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer s");
    expect(init?.headers as Record<string, string>).not.toHaveProperty("X-Aktenraum-Secret");
  });

  it("returns null for a document without a home space", async () => {
    const fetchFn = fetchReturning(200, { space_id: null, space_document_ids: [] });
    expect(await apiSpaceLookup("http://api", "s", fetchFn as unknown as typeof fetch)(5)).toBeNull();
  });

  it("throws when the api fails", async () => {
    const fetchFn = fetchReturning(502, { detail: "x" });
    await expect(apiSpaceLookup("http://api", "s", fetchFn as unknown as typeof fetch)(5)).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("corpusScope", () => {
  it("is undefined (unscoped) without a lookup, null when skipped, the peers otherwise", async () => {
    const skipped: string[] = [];
    const onSkip = (reason: string) => skipped.push(reason);
    expect(await corpusScope(undefined, 1, onSkip)).toBeUndefined();
    expect(await corpusScope(async () => null, 1, onSkip)).toBeNull();
    const failing: SpaceLookup = async () => {
      throw new Error("api down");
    };
    expect(await corpusScope(failing, 1, onSkip)).toBeNull();
    expect(skipped).toEqual(["no_home_space", "api down"]);
    const ok: SpaceLookup = async () => ({ spaceId: 1, sharedWith: [], peers: new Set([1, 2]) });
    expect(await corpusScope(ok, 1, onSkip)).toEqual(new Set([1, 2]));
  });
  it("never widens the corpus with documents shared with someone (tenancy-document-shares)", async () => {
    // B's document 4 lives in B's space {4, 5}. A's document 42 is shared with
    // B, but sharing is per document and the api never lists it as B's peer;
    // the recipients of a document are not a corpus either.
    const fetchFn = fetchReturning(200, {
      document_id: 4,
      space_id: 2,
      shared_with: [7],
      space_document_ids: [4, 5],
    });
    const lookup = apiSpaceLookup("http://api", "s", fetchFn as unknown as typeof fetch);
    const scope = await corpusScope(lookup, 4, () => undefined);
    expect(scope).toEqual(new Set([4, 5]));
    expect(scope?.has(42)).toBe(false);
  });
});

/** Minimal PaperlessClient for the corpus helpers. */
function corpusClient(docs: PaperlessDocument[]): { client: PaperlessClient; sampleSizes: number[] } {
  const sampleSizes: number[] = [];
  const client = {
    getDocumentsWithTag: async (_tag: string, batchSize: number) => {
      sampleSizes.push(batchSize);
      return docs.slice(0, batchSize);
    },
    getCustomFieldNameById: async () => ({ 1: "ai_correspondent", 2: "ai_issue_date", 3: "ai_reference_numbers", 4: "ai_document_type" }),
    getEntityNameMap: async (endpoint: string) =>
      endpoint === "/api/document_types/" ? { 80: "Rechnung" } : endpoint === "/api/correspondents/" ? { 70: "Stadtwerke" } : {},
    getTagId: async () => null,
  } as unknown as PaperlessClient;
  return { client, sampleSizes };
}

function propagated(id: number, text = `Inhalt von Dokument ${id}`): PaperlessDocument {
  return {
    id,
    content: text,
    correspondent: 70,
    document_type: 80,
    tags: [],
    custom_fields: [
      { field: 1, value: "Stadtwerke" },
      { field: 2, value: "2026-03-15" },
      { field: 3, value: "RE-1" },
      { field: 4, value: "Rechnung" },
    ],
  } as PaperlessDocument;
}

describe("few-shot examples stay inside the home space", () => {
  it("uses only allowed documents, from a wider sample", async () => {
    const { client, sampleSizes } = corpusClient([propagated(1, "fremd"), propagated(2, "eigen")]);
    const block = await buildFewShotBlock(client, 1, new Set([2]));
    expect(block).toContain("eigen");
    expect(block).not.toContain("fremd");
    expect(sampleSizes[0]).toBeGreaterThan(1);
  });

  it("yields nothing when no example lives in the space", async () => {
    const { client } = corpusClient([propagated(1)]);
    expect(await buildFewShotBlock(client, 2, new Set([99]))).toBe("");
  });

  it("stays unscoped without a set (no api configured)", async () => {
    const { client, sampleSizes } = corpusClient([propagated(1, "eins")]);
    expect(await buildFewShotBlock(client, 1)).toContain("eins");
    expect(sampleSizes[0]).toBe(1);
  });
});

describe("duplicate detection stays inside the home space", () => {
  it("does not flag a twin from another space", async () => {
    const { client } = corpusClient([propagated(11), propagated(12)]);
    const fields = { ai_correspondent: "Stadtwerke", ai_issue_date: "2026-03-15", ai_reference_numbers: "RE-1", ai_document_type: "Rechnung" };
    const newDoc = propagated(10);
    expect(await findDuplicateIds(client, newDoc, 70, fields)).toEqual([11, 12]);
    expect(await findDuplicateIds(client, newDoc, 70, fields, new Set([10, 11]))).toEqual([11]);
    expect(await findDuplicateIds(client, newDoc, 70, fields, new Set([10]))).toEqual([]);
  });
});
