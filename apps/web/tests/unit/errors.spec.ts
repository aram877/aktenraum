import { describe, expect, it } from "vitest";

import { detailFrom, statusOf } from "~/utils/errors";

function fetchError(statusCode: number | undefined, data?: unknown, statusMessage?: string) {
  return Object.assign(new Error("boom"), { name: "FetchError", statusCode, statusMessage, data });
}

describe("detailFrom", () => {
  it("prefers a string detail from the API body", () => {
    expect(detailFrom(fetchError(404, { detail: "Nicht gefunden" }), "x")).toBe("Nicht gefunden");
  });

  it("uses the first msg of a validation array", () => {
    expect(detailFrom(fetchError(422, { detail: [{ msg: "Passwort zu kurz" }] }), "x")).toBe(
      "Passwort zu kurz",
    );
  });

  it("reports an unreachable server when there is no status", () => {
    expect(detailFrom(fetchError(undefined), "x")).toBe("Server nicht erreichbar.");
  });

  it("falls back to the status line", () => {
    expect(detailFrom(fetchError(502, "<html>", "Bad Gateway"), "x")).toBe("502 Bad Gateway");
  });

  it("uses the fallback for anything that is not a fetch error", () => {
    expect(detailFrom(new Error("nope"), "Fallback")).toBe("Fallback");
  });
});

describe("statusOf", () => {
  it("reads the status code of a fetch error", () => {
    expect(statusOf(fetchError(401))).toBe(401);
  });

  it("returns null otherwise", () => {
    expect(statusOf(new Error("x"))).toBeNull();
  });
});
