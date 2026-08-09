import { describe, expect, it } from "vitest";
import { z } from "zod";
import { recoverKeysForSchema, repairTruncatedJson } from "./ollamaBackend.js";

// Mirrors services/auto-tagger/tests/test_ollama_recovery.py.

const AnswerOutputSchema = z.object({
  answer_de: z.string(),
  cited_ids: z.array(z.number()).default([]),
});

describe("recoverKeysForSchema", () => {
  it("renames a garbled key sharing the canonical prefix", () => {
    // The user-facing repro: a control-token leak corrupts a key but its
    // underscore prefix still matches `answer_de`, and it's the only
    // sibling sharing that prefix, so we rename it.
    const parsed = {
      "answer_<|channel|>{": "Ich konnte das in den Dokumenten nicht finden.",
      cited_ids: [],
    };
    const out = recoverKeysForSchema(parsed, AnswerOutputSchema) as Record<string, unknown>;
    expect(out.answer_de).toBe("Ich konnte das in den Dokumenten nicht finden.");
    expect(out).not.toHaveProperty("answer_<|channel|>{");
    expect(out.cited_ids).toEqual([]);
  });

  it("returns the input unchanged when the canonical key is already present", () => {
    // If the canonical key is already there, leave the dict alone (no
    // mistaken rename of unrelated siblings).
    const parsed = { answer_de: "ok", cited_ids: [1] };
    const out = recoverKeysForSchema(parsed, AnswerOutputSchema);
    expect(out).toBe(parsed);
  });

  it("skips recovery when multiple prefix siblings exist", () => {
    // Ambiguity guard: if more than one key shares the prefix, we don't
    // pick — better to surface the original validation error than to guess.
    const parsed = { answer_garbled1: "a", answer_garbled2: "b", cited_ids: [] };
    const out = recoverKeysForSchema(parsed, AnswerOutputSchema);
    expect(out).toBe(parsed);
  });

  it("does not poach a sibling that is itself a canonical field name", () => {
    // A sibling whose name is itself a different canonical schema field is
    // not eligible to fill in for a missing one — we only rename garbage.
    const parsed = { cited_ids: [1, 2] }; // answer_de missing; cited_ids is canonical
    const out = recoverKeysForSchema(parsed, AnswerOutputSchema);
    expect(out).toBe(parsed);
  });

  it("is a no-op for non-object input", () => {
    const out = recoverKeysForSchema(["not", "a", "dict"], AnswerOutputSchema);
    expect(out).toEqual(["not", "a", "dict"]);
  });
});

describe("repairTruncatedJson", () => {
  it("returns the input unchanged when already valid", () => {
    const text = '{"answer_de": "hi", "cited_ids": [1]}';
    expect(repairTruncatedJson(text)).toBe(text);
  });

  it("closes an unterminated string and braces", () => {
    // User's exact failure mode: model truncated mid-string in summary_de.
    const truncated =
      '{"document_type":"Rechnung","correspondent":"Acme",' +
      '"summary_de":"Satz eins. Satz zwei. Satz drei mit unerwartetem';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired);
    expect(parsed.document_type).toBe("Rechnung");
    expect(parsed.summary_de.endsWith("unerwartetem")).toBe(true);
  });

  it("closes nested array and object", () => {
    const truncated = '{"a": {"b": [1, 2, "three';
    const parsed = JSON.parse(repairTruncatedJson(truncated));
    expect(parsed).toEqual({ a: { b: [1, 2, "three"] } });
  });

  it("drops a dangling comma before the closing brace", () => {
    const truncated = '{"x": 1, "y": "v",';
    const parsed = JSON.parse(repairTruncatedJson(truncated));
    expect(parsed).toEqual({ x: 1, y: "v" });
  });

  it("does not break on escaped quotes inside a string", () => {
    const text = String.raw`{"s": "he said \"hi\""}`; // already valid, escape-aware walk
    expect(repairTruncatedJson(text)).toBe(text);
  });

  it("bails out on a structural mismatch", () => {
    // `}` without matching `{` — repairing this would silently mask a
    // bigger problem, so the helper returns the input untouched and the
    // caller surfaces the original error.
    const bad = '{"a": 1}}';
    expect(repairTruncatedJson(bad)).toBe(bad);
  });
});
