import { describe, expect, it, vi } from "vitest";

import { apiHomeSpaceAssigner, HomeSpacePendingError } from "./home-space.js";

function fetchReturning(status: number, body = "{}") {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status }),
  );
}

describe("apiHomeSpaceAssigner", () => {
  it("POSTs the document id with the worker credential", async () => {
    const fetchFn = fetchReturning(200);
    await apiHomeSpaceAssigner("http://api:8002/", "s3cret", fetchFn as unknown as typeof fetch)(42);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://api:8002/api/tenancy/assign-home-space");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ document_id: 42 });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(init?.headers as Record<string, string>).not.toHaveProperty("X-Aktenraum-Secret");
  });

  it("turns 409 into HomeSpacePendingError", async () => {
    const assign = apiHomeSpaceAssigner("http://api", "s", fetchReturning(409) as unknown as typeof fetch);
    await expect(assign(1)).rejects.toBeInstanceOf(HomeSpacePendingError);
  });

  it("throws with the status on any other failure", async () => {
    const assign = apiHomeSpaceAssigner(
      "http://api",
      "s",
      fetchReturning(502, "bad gateway") as unknown as typeof fetch,
    );
    await expect(assign(1)).rejects.toMatchObject({ status: 502 });
  });
});
