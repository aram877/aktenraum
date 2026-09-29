import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppNav from "~/components/AppNav.vue";
import { fetchError } from "../fetch-error";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));

function calledPaths(): string[] {
  return get.mock.calls.map((call) => String(call[0]));
}

describe("AppNav", () => {
  beforeEach(() => {
    useNuxtApp().$queryClient.clear();
    get.mockReset();
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.reject(fetchError(401));
      return new Promise(() => undefined);
    });
  });

  async function renderUnauthenticated() {
    const wrapper = await mountSuspended(AppNav);
    await vi.waitFor(() =>
      expect(useNuxtApp().$queryClient.getQueryState(ME_KEY)?.status).toBe("success"),
    );
    await flushPromises();
    return wrapper;
  }

  async function renderAuthenticated() {
    useNuxtApp().$queryClient.setQueryData(ME_KEY, { username: "admin" });
    const wrapper = await mountSuspended(AppNav);
    await vi.waitFor(() => expect(wrapper.html()).toContain("<nav"));
    return wrapper;
  }

  it("renders nothing at all while the user is unauthenticated", async () => {
    const wrapper = await renderUnauthenticated();
    expect(wrapper.html()).not.toContain("<nav");
    for (const label of ["Bibliothek", "Hochladen", "Papierkorb", "Einstellungen", "Abmelden"]) {
      expect(wrapper.html()).not.toContain(label);
    }
  });

  it("does not fetch the badge counts while unauthenticated", async () => {
    await renderUnauthenticated();
    expect(calledPaths()).toEqual(["/auth/me"]);
  });

  it("renders the full menu once authenticated", async () => {
    const wrapper = await renderAuthenticated();
    for (const label of ["Start", "Bibliothek", "Hochladen", "Papierkorb", "Einstellungen"]) {
      expect(wrapper.html()).toContain(label);
    }
  });

  describe("review badge", () => {
    it("shows the pending count from the live stream", async () => {
      useNuxtApp().$queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 7, in_flight: 9, trash: 0 });
      const wrapper = await renderAuthenticated();
      expect(wrapper.find('[data-testid="review-badge"]').text()).toBe("7");
    });

    it("falls back to the polled inbox total when the stream has pushed nothing", async () => {
      get.mockImplementation((path: string) => {
        if (path.startsWith("/inbox/")) {
          return Promise.resolve({ results: [], total: 3, page: 1, page_size: 1 });
        }
        return new Promise(() => undefined);
      });
      const wrapper = await renderAuthenticated();
      await vi.waitFor(() => expect(wrapper.find('[data-testid="review-badge"]').text()).toBe("3"));
    });

    it("hides the badge when nothing is waiting for review", async () => {
      useNuxtApp().$queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 0, in_flight: 0, trash: 0 });
      const wrapper = await renderAuthenticated();
      expect(wrapper.find('[data-testid="review-badge"]').exists()).toBe(false);
    });

    it("does not double-count review docs in the in-Bearbeitung pill", async () => {
      useNuxtApp().$queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 4, in_flight: 6, trash: 0 });
      const wrapper = await renderAuthenticated();
      expect(wrapper.find('[data-testid="in-flight-pill"]').text()).toBe("2 in Bearbeitung");
    });

    it("hides the pill when every in-flight doc is already in review", async () => {
      useNuxtApp().$queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 5, in_flight: 5, trash: 0 });
      const wrapper = await renderAuthenticated();
      expect(wrapper.find('[data-testid="in-flight-pill"]').exists()).toBe(false);
    });
  });

  it("opens the mobile drawer from the menu toggle", async () => {
    const wrapper = await renderAuthenticated();
    expect(wrapper.find('[data-testid="nav-drawer"]').exists()).toBe(false);
    await wrapper.find('[data-testid="nav-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="nav-drawer"]').exists()).toBe(true);
  });
});
