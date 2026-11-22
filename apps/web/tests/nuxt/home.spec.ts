import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import HomePage from "~/pages/index.vue";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));

function doc(id: number, type: string | null) {
  return {
    id,
    title: `Dokument ${id}`,
    original_file_name: null,
    created: "2026-11-18",
    added: null,
    correspondent: "Stadtwerke",
    document_type: type,
    lifecycle_tags: ["ai-propagated"],
    tags: [],
    ai_error_message: null,
    is_processing: false,
  };
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  get.mockReset();
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "aram" });
    if (path.startsWith("/ingest/activity")) {
      return Promise.resolve({
        summary: { new: 4, duplicate: 1, failed: 0, running: 0, by_source: { email: 1, upload: 3, folder: 0 } },
        items: [],
        mails: [],
        truncated: false,
      });
    }
    if (path.startsWith("/inbox/")) return Promise.resolve({ results: [], total: 3, page: 1, page_size: 1 });
    if (path === "/documents/in-flight") return Promise.resolve({ count: 5 });
    if (path.startsWith("/library/?status=error")) return Promise.resolve({ results: [], total: 2, page: 1, page_size: 1 });
    if (path === "/library/types") {
      return Promise.resolve({ results: [{ name: "Rechnung", count: 12 }, { name: "Arztbrief", count: 2 }] });
    }
    if (path.startsWith("/library/")) {
      return Promise.resolve({ results: [doc(1, "Rechnung"), doc(2, "Bußgeldbescheid")], total: 2, page: 1, page_size: 6 });
    }
    return new Promise(() => undefined);
  });
});

describe("home page", () => {
  it("shows the four stats, the newest documents with tiles and the areas", async () => {
    const wrapper = await mountSuspended(HomePage, { route: "/" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-newest"]').exists()).toBe(true));

    expect(wrapper.find('[data-testid="page-header"]').text()).toContain("aram");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-stat-review"]').text()).toContain("3"));
    // In flight minus pending review, like the nav pill.
    expect(wrapper.find('[data-testid="home-stat-processing"]').text()).toContain("2");
    expect(wrapper.find('[data-testid="home-errors"]').text()).toContain("2");
    expect(wrapper.find('[data-testid="home-stat-new"]').text()).toContain("4");

    const tiles = wrapper.findAll('[data-testid="home-newest"] [data-testid="doc-type-tile"]');
    expect(tiles.map((t) => t.attributes("data-family"))).toEqual(["geld", "mobil"]);

    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-area-geld"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="home-area-geld"]').attributes("href")).toBe("/library?family=geld");
    expect(wrapper.find('[data-testid="home-area-geld"]').text()).toContain("12");
    expect(wrapper.find('[data-testid="home-area-mobil"]').exists()).toBe(false); // no documents
  });

  it("no longer links to the removed scan page", async () => {
    const wrapper = await mountSuspended(HomePage, { route: "/" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-stats"]').exists()).toBe(true));
    expect(wrapper.find('a[href="/scan"]').exists()).toBe(false);
  });

  it("hands a question over to the Ask page", async () => {
    const wrapper = await mountSuspended(HomePage, { route: "/" });
    await wrapper.find('input[name="home-question"]').setValue("Wann läuft mein Mietvertrag aus?");
    await wrapper.find("form").trigger("submit");
    await vi.waitFor(() => expect(useRoute().path).toBe("/ask"));
    expect(useRoute().query.q).toBe("Wann läuft mein Mietvertrag aus?");
  });
});
