import { describe, expect, it, vi } from "vitest";
import {
  LIFECYCLE_TAGS,
  type DocumentExtraction,
  type DocumentType,
  type PaperlessClient,
  type PaperlessDocument,
} from "@aktenraum/core-ts";

import { applyFallbacks, formatError, isUntrustedSource, lifecycleTagsOn } from "./extract.js";

function extraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    document_type: "Rechnung" as DocumentType,
    correspondent: "Stadtwerke",
    ai_title: "Stromrechnung",
    confidence: 0.92,
    confidence_reason: "Klarer Briefkopf",
    summary_de: "Eine Rechnung.",
    reference_numbers: ["RE-1"],
    suggested_tags: ["Strom"],
    key_dates: { issue: "2026-03-15", due: null, period_start: null, period_end: null },
    ...overrides,
  } as DocumentExtraction;
}

describe("applyFallbacks", () => {
  it("changes nothing when the model filled every field", () => {
    const { extraction: out, applied } = applyFallbacks(extraction(), "irrelevant");
    expect(applied).toEqual([]);
    expect(out).toEqual(extraction());
  });

  it("synthesises ai_title when the model dropped it", () => {
    const { extraction: out, applied } = applyFallbacks(extraction({ ai_title: "" }), "");
    expect(applied).toContain("ai_title");
    expect(out.ai_title).not.toBe("");
  });

  it("treats a whitespace-only field as dropped", () => {
    const { applied } = applyFallbacks(extraction({ summary_de: "   " }), "");
    expect(applied).toContain("summary_de");
  });

  it("synthesises a confidence_reason appropriate to the score", () => {
    const { extraction: out, applied } = applyFallbacks(
      extraction({ confidence_reason: "" }),
      "",
    );
    expect(applied).toContain("confidence_reason");
    expect((out.confidence_reason ?? "").length).toBeGreaterThan(0);
  });

  it("harvests reference numbers from the FULL content, not the truncated prompt text", () => {
    const { extraction: out, applied } = applyFallbacks(
      extraction({ reference_numbers: [] }),
      "…viele Seiten… Aktenzeichen: AZ-4711 …",
    );
    expect(applied).toContain("reference_numbers");
    expect(out.reference_numbers).toEqual(["AZ-4711"]);
  });

  it("does not claim a reference_numbers fallback when the text has none", () => {
    const { applied } = applyFallbacks(
      extraction({ reference_numbers: [] }),
      "keine kennzeichnung hier",
    );
    expect(applied).not.toContain("reference_numbers");
  });

  it("never overrides a value the model did emit", () => {
    const { extraction: out } = applyFallbacks(
      extraction({ suggested_tags: ["NurDieser"] }),
      "Aktenzeichen: AZ-1",
    );
    expect(out.suggested_tags).toEqual(["NurDieser"]);
    expect(out.reference_numbers).toEqual(["RE-1"]);
  });

  it("fills every droppable field at once when the model returned a bare skeleton", () => {
    const { applied } = applyFallbacks(
      extraction({
        ai_title: "",
        confidence_reason: "",
        summary_de: "",
        suggested_tags: [],
        reference_numbers: [],
      }),
      "Aktenzeichen: AZ-9",
    );
    expect(applied.sort()).toEqual(
      ["ai_title", "confidence_reason", "reference_numbers", "suggested_tags", "summary_de"].sort(),
    );
  });
});

describe("formatError", () => {
  it("labels the failure and names the error type", () => {
    expect(formatError("LLM-Extraktion fehlgeschlagen", new TypeError("boom"))).toBe(
      "LLM-Extraktion fehlgeschlagen – TypeError: boom",
    );
  });

  it("handles a non-Error throw without crashing", () => {
    expect(formatError("X", "plain string")).toContain("plain string");
  });
});

const TAG_IDS: Record<string, number> = {
  "ai-pending": 1,
  "ai-approved": 2,
  "ai-rejected": 3,
  "ai-propagated": 4,
  "ai-propagation-error": 5,
  "ai-error": 6,
  "email-ingested": 90,
  wichtig: 91,
};

function tagClient(overrides: Record<string, number | null> = {}): PaperlessClient {
  return {
    getTagId: vi.fn(async (name: string) =>
      name in overrides ? overrides[name] : (TAG_IDS[name] ?? null),
    ),
  } as unknown as PaperlessClient;
}

function doc(tags: number[] | undefined): PaperlessDocument {
  return { id: 1, tags } as unknown as PaperlessDocument;
}

describe("lifecycleTagsOn", () => {
  it("reports the lifecycle tags a document actually carries", async () => {
    expect(await lifecycleTagsOn(tagClient(), doc([91, 4]))).toEqual(["ai-propagated"]);
  });

  it("reports every lifecycle tag when several are set", async () => {
    const present = await lifecycleTagsOn(tagClient(), doc([1, 6]));
    expect(new Set(present)).toEqual(new Set(["ai-pending", "ai-error"]));
  });

  it("returns nothing for an untagged or non-lifecycle-tagged document", async () => {
    expect(await lifecycleTagsOn(tagClient(), doc([]))).toEqual([]);
    expect(await lifecycleTagsOn(tagClient(), doc(undefined))).toEqual([]);
    expect(await lifecycleTagsOn(tagClient(), doc([91]))).toEqual([]);
  });

  it("short-circuits without querying Paperless when the document has no tags", async () => {
    const client = tagClient();
    await lifecycleTagsOn(client, doc([]));
    expect(client.getTagId).not.toHaveBeenCalled();
  });

  it("treats a lifecycle tag that does not exist in Paperless as absent", async () => {
    expect(await lifecycleTagsOn(tagClient({ "ai-propagated": null }), doc([4]))).toEqual([]);
  });

  it("checks the whole lifecycle set, so a new tag cannot be silently skipped", async () => {
    const client = tagClient();
    await lifecycleTagsOn(client, doc([999]));
    expect(vi.mocked(client.getTagId).mock.calls.map(([name]) => name)).toEqual([...LIFECYCLE_TAGS]);
  });
});

describe("isUntrustedSource", () => {
  it("flags an email-ingested document", async () => {
    expect(await isUntrustedSource(tagClient(), doc([90]))).toBe(true);
  });

  it("does not flag a document from a trusted path", async () => {
    expect(await isUntrustedSource(tagClient(), doc([91, 4]))).toBe(false);
    expect(await isUntrustedSource(tagClient(), doc([]))).toBe(false);
    expect(await isUntrustedSource(tagClient(), doc(undefined))).toBe(false);
  });

  it("does not flag when the tag is absent from Paperless entirely", async () => {
    expect(await isUntrustedSource(tagClient({ "email-ingested": null }), doc([90]))).toBe(false);
  });
});
