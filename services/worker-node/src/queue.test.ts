import { describe, expect, it } from "vitest";

import { AsyncQueue } from "./queue.js";
import { ProcessingState } from "./processing-state.js";
import { parseDocumentId, secretMatches } from "./webhook.js";

describe("AsyncQueue", () => {
  it("returns items in FIFO order", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.pop()).toBe(1);
    expect(await q.pop()).toBe(2);
  });

  it("resolves a waiting consumer when an item arrives later", async () => {
    const q = new AsyncQueue<number>();
    const pending = q.pop();
    q.push(42);
    expect(await pending).toBe(42);
  });

  it("hands a pushed item straight to the longest-waiting consumer", async () => {
    const q = new AsyncQueue<number>();
    const first = q.pop();
    const second = q.pop();
    q.push(1);
    q.push(2);
    expect(await first).toBe(1);
    expect(await second).toBe(2);
  });

  it("releases waiters with null on close so loops can exit", async () => {
    const q = new AsyncQueue<number>();
    const pending = q.pop();
    q.close();
    expect(await pending).toBeNull();
  });

  it("drains remaining items before reporting closed", async () => {
    const q = new AsyncQueue<number>();
    q.push(7);
    q.close();
    expect(await q.pop()).toBe(7);
    expect(await q.pop()).toBeNull();
  });
});

describe("ProcessingState", () => {
  it("reports the active ids across slots, deduped", () => {
    const s = new ProcessingState();
    s.set("extraction", 5);
    s.set("indexer", 5);
    s.set("propagation", 9);
    expect(s.activeIds()).toEqual([5, 9]);
  });

  it("clears a slot back to null", () => {
    const s = new ProcessingState();
    s.set("extraction", 1);
    s.set("extraction", null);
    expect(s.activeIds()).toEqual([]);
    expect(s.snapshot()).toEqual({ extraction: null, propagation: null, indexer: null });
  });
});

describe("webhook helpers", () => {
  it("accepts any request when no secret is configured", () => {
    expect(secretMatches(undefined, "")).toBe(true);
  });

  it("rejects a missing or wrong secret once one is configured", () => {
    expect(secretMatches(undefined, "s3cret")).toBe(false);
    expect(secretMatches("wrong", "s3cret")).toBe(false);
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a secret of a different length without throwing", () => {
    expect(secretMatches("short", "muchlongersecret")).toBe(false);
  });

  it("parses a document id from the webhook body", () => {
    expect(parseDocumentId('{"document_id": 12}')).toBe(12);
    expect(parseDocumentId('{"document_id": "12"}')).toBe(12);
  });

  it("rejects a missing, malformed or non-positive id", () => {
    expect(parseDocumentId("{}")).toBeNull();
    expect(parseDocumentId("not json")).toBeNull();
    expect(parseDocumentId('{"document_id": 0}')).toBeNull();
    expect(parseDocumentId('{"document_id": -3}')).toBeNull();
  });
});
