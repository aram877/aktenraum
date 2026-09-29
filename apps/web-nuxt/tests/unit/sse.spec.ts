import { describe, expect, it, vi } from "vitest";

import { dispatchSseRecord, extractErrorDetail, type StreamHandlers } from "~/utils/sse";

function handlers() {
  return {
    onMeta: vi.fn(),
    onChunk: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
  } satisfies Required<StreamHandlers>;
}

describe("dispatchSseRecord", () => {
  it("routes a meta record", () => {
    const h = handlers();
    dispatchSseRecord('event: meta\ndata: {"total":3,"explanation":"x","filter":{}}', h);
    expect(h.onMeta).toHaveBeenCalledWith({ total: 3, explanation: "x", filter: {} });
  });

  it("routes a chunk record to the text delta", () => {
    const h = handlers();
    dispatchSseRecord('event: chunk\ndata: {"text":"Hallo "}', h);
    expect(h.onChunk).toHaveBeenCalledWith("Hallo ");
  });

  it("routes final and error records", () => {
    const h = handlers();
    dispatchSseRecord('event: final\ndata: {"answer_de":"a","citations":[],"total":0}', h);
    dispatchSseRecord('event: error\ndata: {"detail":"kaputt"}', h);
    expect(h.onFinal).toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith("kaputt");
  });

  it("ignores a record with no data line", () => {
    const h = handlers();
    dispatchSseRecord("event: chunk", h);
    expect(h.onChunk).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON rather than throwing mid-stream", () => {
    const h = handlers();
    expect(() => dispatchSseRecord("event: chunk\ndata: {not json", h)).not.toThrow();
    expect(h.onChunk).not.toHaveBeenCalled();
  });

  it("joins multi-line data payloads", () => {
    const h = handlers();
    dispatchSseRecord('event: chunk\ndata: {"text":\ndata: "x"}', h);
    expect(h.onChunk).toHaveBeenCalledWith("x");
  });
});

describe("extractErrorDetail", () => {
  it("prefers FastAPI's detail field", () => {
    expect(extractErrorDetail('{"detail":"Paperless rejected the API token"}', "fb")).toBe(
      "Paperless rejected the API token",
    );
  });

  it("falls back to a short raw body", () => {
    expect(extractErrorDetail("Bad Gateway", "fb")).toBe("Bad Gateway");
  });

  it("falls back to the status text for a huge body", () => {
    expect(extractErrorDetail("x".repeat(2000), "502 Bad Gateway")).toBe("502 Bad Gateway");
  });

  it("falls back on an empty body", () => {
    expect(extractErrorDetail("", "502 Bad Gateway")).toBe("502 Bad Gateway");
  });
});
