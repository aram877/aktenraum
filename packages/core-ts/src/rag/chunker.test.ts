import { describe, expect, it } from "vitest";
import { chunkText } from "./chunker.js";

// Mirrors services/auto-tagger/tests/test_rag_chunker.py.

describe("chunkText — empty/degenerate inputs", () => {
  it("returns no chunks for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns no chunks for whitespace-only text", () => {
    expect(chunkText("   \n\n  \t\n")).toEqual([]);
  });
});

describe("chunkText — happy path", () => {
  it("yields a single chunk for short text", () => {
    const text = "Mein Lebenslauf. Ich arbeite seit 2022 bei Kopfstand als Frontend Engineer.";
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    const chunk = chunks[0]!;
    expect(chunk.index).toBe(0);
    expect(chunk.text).toBe(text);
    expect(chunk.charStart).toBe(0);
    expect(chunk.charEnd).toBe(text.length);
    expect(chunk.tokenCount).toBe(11);
  });

  it("packs paragraphs into one chunk when under target", () => {
    const text =
      "Erster Absatz mit ein paar Worten.\n\n" +
      "Zweiter Absatz, ebenso kurz.\n\n" +
      "Dritter Absatz.";
    const chunks = chunkText(text, { targetTokens: 500 });
    expect(chunks.length).toBe(1);
    // Paragraph break preserved as `\n\n` between joined paragraphs.
    expect((chunks[0]!.text.match(/\n\n/g) ?? []).length).toBe(2);
  });

  it("splits paragraphs when over target", () => {
    // Four paragraphs of ~10 words each. With targetTokens=15 each chunk
    // holds at most one paragraph; with targetTokens=25 it holds two.
    const paras = [
      "Eins zwei drei vier fünf sechs sieben acht neun zehn",
      "elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig",
      "alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "lambda mu nu xi omikron pi rho sigma tau ypsilon",
    ];
    const text = paras.join("\n\n");
    const chunks = chunkText(text, { targetTokens: 15, overlapTokens: 0 });
    // Each paragraph is ~10 tokens; can't fit two (~20) in 15; so 4 chunks.
    expect(chunks.length).toBe(4);
    chunks.forEach((chunk, i) => expect(chunk.text).toBe(paras[i]));
    // Char offsets must be strictly increasing — no overlap when overlap=0.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.charEnd).toBeLessThanOrEqual(chunks[i + 1]!.charStart);
    }
  });

  it("prepends the tail of the previous chunk when overlap is set", () => {
    const paras = [
      "alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "lambda mu nu xi omikron pi rho sigma tau ypsilon",
    ];
    const text = paras.join("\n\n");
    const chunks = chunkText(text, { targetTokens: 15, overlapTokens: 3 });
    expect(chunks.length).toBe(2);
    // Second chunk must start with the last 3 tokens of the first.
    expect(chunks[1]!.text.startsWith("theta iota kappa ")).toBe(true);
    // The overlap shouldn't appear in the first chunk's text (it's raw paragraph).
    expect(chunks[0]!.text).toBe(paras[0]);
    // Char range of chunk 2 must reach back into chunk 1's tail.
    expect(chunks[1]!.charStart).toBeLessThan(chunks[0]!.charEnd);
  });

  it("disables prepending when overlap is zero", () => {
    const paras = ["alpha beta gamma delta epsilon zeta", "eta theta iota kappa lambda mu"];
    const text = paras.join("\n\n");
    const chunks = chunkText(text, { targetTokens: 10, overlapTokens: 0 });
    expect(chunks.length).toBe(2);
    // No overlap: each chunk equals its source paragraph verbatim.
    expect(chunks[0]!.text).toBe(paras[0]);
    expect(chunks[1]!.text).toBe(paras[1]);
  });
});

describe("chunkText — monolithic paragraphs trigger sentence fallback", () => {
  it("splits an oversize paragraph at sentence boundaries", () => {
    // A single 60-word "paragraph" of 5 sentences, each 12 words. With
    // targetTokens=20 it cannot fit; the splitter must drop to
    // sentence-level packing — three chunks of 1+1, 1+1, 1 sentences.
    const sentences = [
      "Ich arbeitete in einer kleinen Agentur an einem grossen Projekt mit vielen Teammitgliedern.",
      "Wir bauten eine Webanwendung mit React TypeScript Tailwind und einer kleinen Node-API.",
      "Das Projekt lief ueber zwoelf Monate und wir lieferten in drei iterativen Phasen.",
      "Die Kunden waren mit der Qualitaet und der Geschwindigkeit der Auslieferung sehr zufrieden.",
      "Ich uebernahm spaeter die Rolle der technischen Leitung und mentorierte zwei Juniors.",
    ];
    const text = sentences.join(" ");
    const chunks = chunkText(text, { targetTokens: 20, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Each sentence must appear in some chunk (no content drop).
    const rejoined = chunks.map((c) => c.text).join(" ");
    for (const s of sentences) {
      expect(rejoined).toContain(s);
    }
  });

  it("does not force a split on a German abbreviation", () => {
    // "Z. B." is a common German abbreviation — the regex must not split
    // there because the next char is a lowercase letter.
    const text = "Hier ist ein Satz mit z. B. einer Abkuerzung. Hier kommt der naechste Satz.";
    const chunks = chunkText(text, { targetTokens: 500 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("z. B.");
  });

  it("keeps a single too-long sentence intact", () => {
    // If a paragraph has no sentence boundaries AND exceeds target, keep it
    // whole rather than chopping mid-word — the embedder will truncate to
    // its model context, which is preferable to bad splits.
    const longSentence = Array.from({ length: 80 }, (_, i) => `wort${i}`).join(" "); // 80 tokens, no .!?
    const chunks = chunkText(longSentence, { targetTokens: 20, overlapTokens: 0 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(longSentence);
  });
});

describe("chunkText — chunk metadata invariants", () => {
  it("has sequential indices from zero", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Absatz nummer ${i} mit ein paar Worten`).join(
      "\n\n",
    );
    const chunks = chunkText(text, { targetTokens: 10, overlapTokens: 0 });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("token_count matches the internal estimate", () => {
    const text = "alpha beta gamma delta epsilon";
    const chunks = chunkText(text);
    expect(chunks[0]!.tokenCount).toBe(5);
  });

  it("char offsets recover the original substring", () => {
    // For a no-overlap chunk, slicing the original text by
    // [charStart, charEnd) must reproduce the chunk's text verbatim
    // (paragraph-joined text uses the same \n\n separator the original had).
    const text = "Erster Absatz hier.\n\nZweiter Absatz hier.\n\nDritter Absatz hier.";
    const chunks = chunkText(text, { targetTokens: 4, overlapTokens: 0 });
    for (const chunk of chunks) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("keeps a short document even below the min-chunk threshold", () => {
    // A whole document shorter than MIN_CHUNK_TOKENS still produces one
    // chunk. The threshold exists to filter overlap-only stub *follow-on*
    // chunks, not to silently drop short documents (a one-line CV is still
    // a document worth indexing).
    const chunks = chunkText("alpha beta gamma"); // 3 tokens, below MIN_CHUNK_TOKENS=5
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.tokenCount).toBe(3);
  });

  it("drops subsequent stub chunks below the threshold", () => {
    // Long first paragraph, tiny trailing one. Target chosen so packing
    // produces (long, short) and the short one is below threshold.
    const longPara = Array.from({ length: 20 }, (_, i) => `wort${i}`).join(" "); // 20 tokens
    const shortPara = "abc"; // 1 token
    const text = `${longPara}\n\n${shortPara}`;
    const chunks = chunkText(text, { targetTokens: 15, overlapTokens: 0 });
    // First chunk fits the whole 20-token paragraph (monstrous single
    // paragraph case, lands as one chunk regardless). Then "abc" is a
    // 1-token follow-on; under-threshold, so it must be dropped.
    expect(chunks.slice(1).every((c) => c.tokenCount >= 5)).toBe(true);
  });
});

describe("chunkText — configuration validation", () => {
  it.each([0, -1, -100])("rejects a non-positive targetTokens of %i", (target) => {
    expect(() => chunkText("some text", { targetTokens: target })).toThrow(
      /targetTokens must be positive/,
    );
  });

  it("rejects a negative overlapTokens", () => {
    expect(() => chunkText("some text", { overlapTokens: -1 })).toThrow(
      /overlapTokens must be non-negative/,
    );
  });

  it("rejects overlap >= target", () => {
    expect(() => chunkText("some text", { targetTokens: 10, overlapTokens: 10 })).toThrow(
      /overlapTokens .* must be < targetTokens/,
    );
  });
});

describe("chunkText — normalisation", () => {
  it("normalises Windows line endings", () => {
    const text = "Erster Absatz.\r\n\r\nZweiter Absatz.";
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).not.toContain("\r");
  });

  it("collapses runs of horizontal whitespace", () => {
    const text = "alpha    beta\t\tgamma   delta";
    const chunks = chunkText(text);
    expect(chunks[0]!.text).toBe("alpha beta gamma delta");
  });
});

describe("chunkText — Chunk is frozen", () => {
  it("throws on mutation", () => {
    // Chunks travel through the indexing pipeline by reference; freezing
    // them prevents accidental mutation downstream.
    const chunks = chunkText("hello world foo bar baz");
    const chunk = chunks[0]!;
    expect(() => {
      // @ts-expect-error — intentionally mutating a frozen object for the test
      chunk.text = "modified";
    }).toThrow();
  });
});
