import { describe, expect, it } from "vitest";

import { EMPTY_FILTER, type DocumentSummary, type SearchFilter } from "./ai.schemas.js";
import {
  broadenForAnswer,
  extractInlineCitations,
  groupChunksByDoc,
  isDegenerateAnswer,
  isDenialAnswer,
  rankedUniqueDocIds,
  resolveCitations,
  userTagVocabulary,
} from "./ai.service.js";
import type { RetrievedChunk } from "./retrieval.js";

function filter(overrides: Partial<SearchFilter> = {}): SearchFilter {
  return { ...EMPTY_FILTER, tags: [], ...overrides };
}

function chunk(docId: number, chunkIndex: number, text: string): RetrievedChunk {
  return {
    docId,
    chunkIndex,
    text,
    score: 1,
    docType: null,
    correspondent: null,
    tags: [],
    createdDate: null,
    page: null,
  };
}

function summary(id: number): DocumentSummary {
  return {
    id,
    title: `Dokument #${id}`,
    original_file_name: null,
    correspondent: null,
    document_type: null,
    created: null,
    lifecycle_tags: [],
    tags: [],
    ai_error_message: null,
  };
}

describe("extractInlineCitations", () => {
  it("pulls ids out of markers in first-seen order", () => {
    expect(
      extractInlineCitations("Der Betrag ist 12 €. [Quelle: 17] Und auch [Quelle: 4]."),
    ).toEqual([17, 4]);
  });

  it("dedupes repeated citations", () => {
    expect(extractInlineCitations("[Quelle: 7] ... [Quelle: 7]")).toEqual([7]);
  });

  it("tolerates whitespace and case variation", () => {
    expect(extractInlineCitations("[quelle:  23 ]")).toEqual([23]);
  });

  it("returns nothing when the model cited nothing", () => {
    expect(extractInlineCitations("Ein Text ohne Marker.")).toEqual([]);
  });

  it("does not carry regex state between calls", () => {
    const text = "[Quelle: 1]";
    expect(extractInlineCitations(text)).toEqual([1]);
    expect(extractInlineCitations(text)).toEqual([1]);
  });
});

describe("isDenialAnswer", () => {
  it("detects the baked denial template", () => {
    expect(isDenialAnswer("Ich konnte das in den Dokumenten nicht finden.")).toBe(true);
  });

  it("detects the common small-model variants", () => {
    expect(isDenialAnswer("Keine passenden Dokumente vorhanden.")).toBe(true);
    expect(isDenialAnswer("Keines der Dokumente enthält diese Angabe.")).toBe(true);
    expect(isDenialAnswer("Die Angabe ist nicht in den bereitgestellten Dokumenten.")).toBe(
      true,
    );
  });

  it("does NOT treat a long partial answer as a denial", () => {
    const partial =
      "Ich konnte den genauen Betrag in den Dokumenten nicht finden, aber die Rechnung " +
      "vom 15. März nennt eine Teilsumme von 149,99 €, und der Kontoauszug vom selben " +
      "Monat zeigt eine Abbuchung in ähnlicher Höhe. [Quelle: 12] Bitte prüfe zusätzlich " +
      "die Anlage zur Jahresabrechnung, dort steht die Endsumme.";
    expect(partial.length).toBeGreaterThan(200);
    expect(isDenialAnswer(partial)).toBe(false);
  });

  it("is false for a normal answer and for empty text", () => {
    expect(isDenialAnswer("Die Rechnung betrug 149,99 €.")).toBe(false);
    expect(isDenialAnswer("")).toBe(false);
  });
});

describe("isDegenerateAnswer", () => {
  it("catches a model echoing the schema field name", () => {
    expect(isDegenerateAnswer("answer_de")).toBe(true);
    expect(isDegenerateAnswer("Antwort:")).toBe(true);
    expect(isDegenerateAnswer("string")).toBe(true);
  });

  it("treats empty text as degenerate", () => {
    expect(isDegenerateAnswer("")).toBe(true);
  });

  it("leaves a real short answer alone", () => {
    expect(isDegenerateAnswer("149,99 €")).toBe(false);
    expect(isDegenerateAnswer("Ja.")).toBe(false);
  });
});

describe("broadenForAnswer", () => {
  it("strips tags, which would otherwise AND-narrow to nothing", () => {
    const result = broadenForAnswer(filter({ tags: ["Gehalt", "Verdienstabrechnung"] }));
    expect(result.tags).toEqual([]);
  });

  it("drops free text once a structural field constrains the search", () => {
    const result = broadenForAnswer(
      filter({ document_type: "Gehaltsabrechnung", text: "verdient" }),
    );
    expect(result.text).toBeNull();
    expect(result.document_type).toBe("Gehaltsabrechnung");
  });

  it("keeps free text when nothing structural is set", () => {
    const result = broadenForAnswer(filter({ text: "Stromrechnung" }));
    expect(result.text).toBe("Stromrechnung");
  });

  it("treats a date bound alone as structural", () => {
    const result = broadenForAnswer(filter({ date_from: "2026-01-01", text: "kostete" }));
    expect(result.text).toBeNull();
  });

  it("returns an equivalent filter when there is nothing to broaden", () => {
    const input = filter({ document_type: "Rechnung" });
    expect(broadenForAnswer(input)).toEqual(input);
  });
});

describe("groupChunksByDoc", () => {
  it("buckets by doc id preserving rank order", () => {
    const grouped = groupChunksByDoc([chunk(1, 0, "a"), chunk(2, 0, "b"), chunk(1, 1, "c")]);
    expect(grouped.get(1)).toEqual(["a", "c"]);
    expect(grouped.get(2)).toEqual(["b"]);
  });

  it("caps each doc at three chunks so one long doc cannot crowd out the rest", () => {
    const grouped = groupChunksByDoc([
      chunk(1, 0, "a"),
      chunk(1, 1, "b"),
      chunk(1, 2, "c"),
      chunk(1, 3, "d"),
    ]);
    expect(grouped.get(1)).toEqual(["a", "b", "c"]);
  });
});

describe("rankedUniqueDocIds", () => {
  it("dedupes while preserving the reranker's ordering", () => {
    expect(
      rankedUniqueDocIds([chunk(5, 0, "a"), chunk(3, 0, "b"), chunk(5, 1, "c")]),
    ).toEqual([5, 3]);
  });
});

describe("resolveCitations", () => {
  it("drops hallucinated ids that were never in the searched set", () => {
    const resolved = resolveCitations([1, 999], [summary(1), summary(2)]);
    expect(resolved.map((row) => row.id)).toEqual([1]);
  });

  it("preserves citation order and dedupes", () => {
    const resolved = resolveCitations([2, 1, 2], [summary(1), summary(2)]);
    expect(resolved.map((row) => row.id)).toEqual([2, 1]);
  });
});

describe("userTagVocabulary", () => {
  it("hides the lifecycle vocabulary from the filter LLM", () => {
    const vocab = userTagVocabulary({
      "ai-pending": 1,
      "ai-propagated": 2,
      "ai-low-confidence": 3,
      wichtig: 4,
      Versicherung: 5,
    });
    expect(vocab.sort()).toEqual(["Versicherung", "wichtig"]);
  });
});
