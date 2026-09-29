import { mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { describe, expect, it, vi } from "vitest";

import HealthPage from "~/pages/health.vue";

describe("health page", () => {
  it("renders the API status once the request resolves", async () => {
    clearNuxtData("health");
    const handler = vi.fn(() => ({ status: "ok" }));
    registerEndpoint("/api/health", handler);
    const wrapper = await mountSuspended(HealthPage);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="state"]').text()).toBe("API-Status: ok"),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("renders an error state when the API fails", async () => {
    clearNuxtData("health");
    registerEndpoint("/api/health", () => {
      throw new Error("boom");
    });
    const wrapper = await mountSuspended(HealthPage);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="state"]').text()).toContain("Fehler:"));
  });
});
