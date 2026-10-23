import { describe, expect, it } from "vitest";

import {
  classifyOutcome,
  classifySource,
  failureMessage,
  parseDuplicateTarget,
  summariseMailError,
} from "./ingest.service.js";

describe("classifyOutcome", () => {
  it.each([
    [{ status: "SUCCESS" }, "new"],
    [{ status: "PENDING" }, "running"],
    [{ status: "STARTED" }, "running"],
    [{ status: "FAILURE", result: "x.pdf: It is a duplicate of A (#1)." }, "duplicate"],
    [{ status: "FAILURE", result: "x.pdf: PDF is damaged" }, "failed"],
  ])("%o → %s", (task, expected) => {
    expect(classifyOutcome(task)).toBe(expected);
  });
});

describe("classifySource", () => {
  const uploads = new Set(["u1"]);
  it("prefers the recorded upload id over the owner", () => {
    expect(classifySource({ task_id: "u1", owner: 3 }, uploads)).toBe("upload");
  });
  it("treats ownerless tasks as the consume folder", () => {
    expect(classifySource({ task_id: "f1", owner: null }, uploads)).toBe("folder");
  });
  it("treats other owned tasks as e-mail", () => {
    expect(classifySource({ task_id: "m1", owner: 3 }, uploads)).toBe("email");
  });
});

describe("parseDuplicateTarget", () => {
  it("falls back to the id in the message when related_document is missing", () => {
    expect(
      parseDuplicateTarget({ result: "a.pdf: It is a duplicate of Lohn (Mai) (#39).", related_document: null }),
    ).toEqual({ id: 39, title: "Lohn (Mai)" });
  });
  it("keeps the id even when the message does not match", () => {
    expect(parseDuplicateTarget({ result: "anders formuliert", related_document: "12" })).toEqual({
      id: 12,
      title: null,
    });
  });
});

describe("failureMessage", () => {
  it("leaves a message without the filename prefix untouched", () => {
    expect(failureMessage({ task_file_name: "a.pdf", result: "Timeout" })).toBe("Timeout");
  });
});

describe("summariseMailError", () => {
  it.each([null, "", "None"])("%o → null", (raw) => {
    expect(summariseMailError(raw)).toBeNull();
  });
  it("truncates long last lines", () => {
    const summary = summariseMailError(`Traceback\n${"x".repeat(500)}`);
    expect(summary).toHaveLength(200);
    expect(summary?.endsWith("…")).toBe(true);
  });
});
