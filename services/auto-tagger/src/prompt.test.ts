import { describe, expect, it, vi } from "vitest";
import type { DocumentExtraction, DocumentType, PaperlessClient } from "@aktenraum/core";

import {
  buildFewShotBlock,
  buildHistoryHint,
  fallbackConfidenceReason,
  formatHistoryHint,
  splitCsv,
  SYSTEM_PROMPT,
  synthesizeAiTitle,
  truncateText,
} from "./prompt.js";

function extraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return {
    document_type: "Rechnung" as DocumentType,
    correspondent: "Stadtwerke",
    ai_title: "",
    confidence: 0.9,
    confidence_reason: "",
    summary_de: "",
    reference_numbers: [],
    suggested_tags: [],
    key_dates: { issue: "2026-03-15", due: null, period_start: null, period_end: null },
    ...overrides,
  } as DocumentExtraction;
}

describe("SYSTEM_PROMPT", () => {
  it("is the full German prompt, not a stub", () => {
    expect(SYSTEM_PROMPT.length).toBe(14118);
  });

  it("still names every disambiguation rule the taxonomy depends on", () => {
    for (const marker of ["Sozialversicherungsmeldung", "Lohnsteuerbescheinigung", "Hausgeldabrechnung", "Bußgeldbescheid", "Krankschreibung", "Spendenbescheinigung"]) {
      expect(SYSTEM_PROMPT).toContain(marker);
    }
  });
});

describe("truncateText", () => {
  it("leaves text under the budget untouched", () => {
    expect(truncateText("kurz", 10)).toBe("kurz");
  });

  it("truncates at 4 chars per token and appends the German notice", () => {
    const out = truncateText("x".repeat(100), 10);
    expect(out.startsWith("x".repeat(40))).toBe(true);
    expect(out).toContain("gekürzt");
    expect(out.length).toBeGreaterThan(40);
  });

  it("does not append the notice at exactly the budget", () => {
    expect(truncateText("x".repeat(40), 10)).toBe("x".repeat(40));
  });
});

describe("splitCsv", () => {
  it("splits and trims", () => {
    expect(splitCsv(" a , b ,c ")).toEqual(["a", "b", "c"]);
  });

  it("drops empty segments", () => {
    expect(splitCsv("a,,b,")).toEqual(["a", "b"]);
  });

  it("returns nothing for null, empty and whitespace-only", () => {
    expect(splitCsv(null)).toEqual([]);
    expect(splitCsv("")).toEqual([]);
    expect(splitCsv(" , ")).toEqual([]);
  });
});

describe("fallbackConfidenceReason", () => {
  it("uses the high tier at and above 0.85", () => {
    expect(fallbackConfidenceReason(0.85)).toContain("Klarer Briefkopf");
    expect(fallbackConfidenceReason(0.99)).toContain("Klarer Briefkopf");
  });

  it("uses the middle tier between 0.6 and 0.85", () => {
    expect(fallbackConfidenceReason(0.6)).toContain("leicht unscharf");
    expect(fallbackConfidenceReason(0.84)).toContain("leicht unscharf");
  });

  it("uses the low tier below 0.6", () => {
    expect(fallbackConfidenceReason(0.59)).toContain("fragmentiert");
    expect(fallbackConfidenceReason(0)).toContain("fragmentiert");
  });
});

describe("synthesizeAiTitle", () => {
  it("builds a title from type, correspondent and date", () => {
    const title = synthesizeAiTitle(extraction());
    expect(title).toContain("Rechnung");
    expect(title).toContain("Stadtwerke");
  });

  it("is never empty even with only a document type", () => {
    const title = synthesizeAiTitle(
      extraction({ correspondent: null, key_dates: { issue: null } as never }),
    );
    expect(title.length).toBeGreaterThan(0);
  });
});

describe("formatHistoryHint", () => {
  it("names the dominant type at >=70% of >=2 samples", () => {
    const hint = formatHistoryHint("AOK", { Rechnung: 8, Bescheid: 2 });
    expect(hint).toContain("in 8 von 10 Fällen als 'Rechnung'");
    expect(hint).toContain("weiche aber ab");
  });

  it("lists the distribution when no type dominates", () => {
    const hint = formatHistoryHint("AOK", { Rechnung: 5, Bescheid: 5 });
    expect(hint).toContain("bisherige Klassifikationen:");
    expect(hint).toContain("Rechnung: 5");
  });

  it("orders the distribution by descending count", () => {
    const hint = formatHistoryHint("AOK", { Bescheid: 1, Rechnung: 4, Vertrag: 2 });
    expect(hint.indexOf("Rechnung: 4")).toBeLessThan(hint.indexOf("Vertrag: 2"));
    expect(hint.indexOf("Vertrag: 2")).toBeLessThan(hint.indexOf("Bescheid: 1"));
  });

  it("does NOT claim dominance on a single sample, even at 100%", () => {
    const hint = formatHistoryHint("AOK", { Rechnung: 1 });
    expect(hint).toContain("bisherige Klassifikationen:");
    expect(hint).not.toContain("von 1 Fällen");
  });

  it("returns nothing when the counts are all zero", () => {
    expect(formatHistoryHint("AOK", { Rechnung: 0 })).toBe("");
  });
});

describe("buildHistoryHint", () => {
  function client(history: Record<string, Record<string, number>>): PaperlessClient {
    return { getCorrespondentHistory: vi.fn().mockResolvedValue(history) } as unknown as PaperlessClient;
  }

  it("matches a known sender mentioned in the document head", async () => {
    const hint = await buildHistoryHint(client({ AOK: { Rechnung: 3 } }), "Brief von AOK ...");
    expect(hint).toContain("AOK");
  });

  it("ignores a sender that appears only past the head window", async () => {
    const text = `${"x".repeat(1200)} AOK`;
    expect(await buildHistoryHint(client({ AOK: { Rechnung: 3 } }), text)).toBe("");
  });

  it("prefers the longest matching name so a substring cannot win", async () => {
    const hint = await buildHistoryHint(
      client({ AOK: { Bescheid: 9 }, "AOK NordWest": { Rechnung: 9 } }),
      "Absender: AOK NordWest",
    );
    expect(hint).toContain("AOK NordWest");
    expect(hint).toContain("Rechnung");
  });

  it("returns nothing on empty history or no match", async () => {
    expect(await buildHistoryHint(client({}), "irgendwas")).toBe("");
    expect(await buildHistoryHint(client({ AOK: { Rechnung: 3 } }), "kein treffer")).toBe("");
  });

  it("degrades to no hint when the history fetch fails", async () => {
    const failing = {
      getCorrespondentHistory: vi.fn().mockRejectedValue(new Error("paperless down")),
    } as unknown as PaperlessClient;
    expect(await buildHistoryHint(failing, "AOK")).toBe("");
  });
});

describe("buildFewShotBlock", () => {
  const FIELD_NAMES = { 1: "ai_document_type", 2: "ai_correspondent", 3: "ai_summary_de", 4: "ai_confidence" };

  function client(docs: Record<string, unknown>[], maps: Record<string, Record<number, string>> = {}) {
    const getDocumentsWithTag = vi.fn().mockResolvedValue(docs);
    return {
      client: {
        getDocumentsWithTag,
        getCustomFieldNameById: vi.fn().mockResolvedValue(FIELD_NAMES),
        getEntityNameMap: vi.fn(async (path: string) => maps[path] ?? {}),
      } as unknown as PaperlessClient,
      getDocumentsWithTag,
    };
  }

  const propagated = {
    id: 1,
    content: "Rechnung der Stadtwerke über Strom.",
    correspondent: 7,
    document_type: 3,
    created_date: "2026-03-15",
    tags: [11, 12],
    custom_fields: [
      { field: 3, value: "Stromrechnung für Q1." },
      { field: 4, value: 0.92 },
    ],
  };
  const maps = {
    "/api/correspondents/": { 7: "Stadtwerke" },
    "/api/document_types/": { 3: "Rechnung" },
    "/api/tags/": { 11: "energie", 12: "ai-propagated" },
  };

  it("returns nothing when disabled", async () => {
    const { client: c, getDocumentsWithTag } = client([propagated], maps);
    expect(await buildFewShotBlock(c, 0)).toBe("");
    expect(getDocumentsWithTag).not.toHaveBeenCalled();
  });

  it("pulls the most recently modified propagated documents", async () => {
    const { client: c, getDocumentsWithTag } = client([propagated], maps);
    await buildFewShotBlock(c, 3);
    expect(getDocumentsWithTag).toHaveBeenCalledWith("ai-propagated", 3, "-modified");
  });

  it("renders native names, not raw ids, as the expected output", async () => {
    const block = await buildFewShotBlock(client([propagated], maps).client, 1);
    expect(block).toContain('"document_type": "Rechnung"');
    expect(block).toContain('"correspondent": "Stadtwerke"');
    expect(block).toContain("Eingabe-Text:");
    expect(block).toContain("Erwartete Ausgabe (JSON):");
    expect(JSON.parse(block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1))).toMatchObject({
      document_type: "Rechnung",
      summary_de: "Stromrechnung für Q1.",
      confidence: 0.92,
    });
  });

  it("never leaks a lifecycle tag into the exemplar's suggested tags", async () => {
    const block = await buildFewShotBlock(client([propagated], maps).client, 1);
    expect(block).toContain('"energie"');
    expect(block).not.toContain('"ai-propagated"');
  });

  it("synthesizes a confidence reason when the corpus has none stored", async () => {
    const block = await buildFewShotBlock(client([propagated], maps).client, 1);
    expect(block).toContain("Klarer Briefkopf");
  });

  it("skips documents with no text and documents with no resolvable type", async () => {
    const empty = { ...propagated, id: 2, content: "   " };
    const typeless = { ...propagated, id: 3, document_type: null, custom_fields: [] };
    expect(await buildFewShotBlock(client([empty, typeless], maps).client, 5)).toBe("");
  });

  it("truncates a long exemplar and marks the cut", async () => {
    const long = { ...propagated, content: "x".repeat(2000) };
    const block = await buildFewShotBlock(client([long], maps).client, 1);
    expect(block).toContain("[...gekürzt]");
    expect(block).not.toContain("x".repeat(1501));
  });

  it("separates multiple exemplars", async () => {
    const second = { ...propagated, id: 2, content: "Zweites Dokument." };
    const block = await buildFewShotBlock(client([propagated, second], maps).client, 2);
    expect(block).toContain("\n---\n");
  });

  it("returns nothing when the corpus is empty", async () => {
    expect(await buildFewShotBlock(client([], maps).client, 5)).toBe("");
  });
});
