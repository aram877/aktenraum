import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LibraryPage from "~/pages/library/index.vue";
import ReviewTab from "~/components/library/ReviewTab.vue";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));

function libraryItem(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Dokument ${id}`,
    original_file_name: null,
    created: "2026-01-01",
    added: null,
    correspondent: "Stadtwerke",
    document_type: "Rechnung",
    lifecycle_tags: ["ai-propagated"],
    tags: ["ai-propagated", "strom", "wichtig"],
    ai_error_message: null,
    is_processing: false,
    ...overrides,
  };
}

function inboxItem(id: number) {
  return {
    id,
    title: `Scan ${id}`,
    original_file_name: null,
    created: null,
    added: null,
    ai_correspondent: "Vitego",
    ai_document_type: "Beleg",
    ai_title: `Beleg ${id}`,
    ai_issue_date: "2026-07-30",
    ai_confidence: 0.82,
    low_confidence: false,
    ai_error_message: null,
  };
}

function libraryCalls(): string[] {
  return get.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith("/library/?") || p === "/library/");
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "admin" });
    if (path === "/library/tags") return Promise.resolve({ results: [{ name: "strom", count: 2 }] });
    if (path.startsWith("/library/")) {
      return Promise.resolve({ results: [libraryItem(1)], total: 60, page: 1, page_size: 25 });
    }
    return new Promise(() => undefined);
  });
});

describe("library archive", () => {
  it("builds the request from the URL and hides lifecycle tags", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?document_type=Rechnung&tags=strom" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    expect(libraryCalls()).toEqual([
      "/library/?document_type=Rechnung&tags=strom&ordering=-created&page=1&page_size=25",
    ]);
    expect(wrapper.text()).toContain("★ wichtig");
    expect(wrapper.text()).not.toContain("ai-propagated");
  });

  it("issues a new request when the URL changes, with no manual refetch", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Seite 1 von 3"));
    await wrapper.find('[data-testid="next-page"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("Seite 2 von 3"));
    expect(libraryCalls().at(-1)).toContain("page=2");
    expect(useRoute().query).toEqual({ page: "2" });
  });

  it("resets to page 1 when a filter changes", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?page=2" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    await wrapper.find('select[name="document_type"]').setValue("Vertrag");
    await flushPromises();
    await vi.waitFor(() => expect(useRoute().query).toEqual({ document_type: "Vertrag" }));
  });

  it("debounces the full-text search into the URL", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    vi.useFakeTimers();
    await wrapper.find('input[name="text"]').setValue("strom");
    vi.advanceTimersByTime(399);
    expect(useRoute().query.text).toBeUndefined();
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(useRoute().query).toEqual({ text: "strom" }));
  });

  it("renders a table for desktop and cards for mobile", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    expect(wrapper.find("div.hidden.md\\:block table").exists()).toBe(true);
    expect(wrapper.find("ul.md\\:hidden li").exists()).toBe(true);
  });

  it("shows the review tab when the URL asks for it", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?tab=review" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Zur Prüfung"));
    expect(wrapper.find('[data-testid="library-total"]').exists()).toBe(false);
  });
});

describe("review tab", () => {
  beforeEach(() => {
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.resolve({ username: "admin" });
      if (path.startsWith("/inbox/?")) {
        return Promise.resolve({ results: [inboxItem(1), inboxItem(2)], total: 2, page: 1, page_size: 50 });
      }
      return new Promise(() => undefined);
    });
  });

  it("bulk-approves the selection and invalidates inbox and library", async () => {
    post.mockImplementation((path: string) =>
      path === "/inbox/2/approve" ? Promise.reject(new Error("409")) : Promise.resolve({}),
    );
    const invalidate = vi.spyOn(useNuxtApp().$queryClient, "invalidateQueries");
    const wrapper = await mountSuspended(ReviewTab);
    await vi.waitFor(() => expect(wrapper.text()).toContain("Beleg 1"));

    await wrapper.find('[data-testid="select-all"]').setValue(true);
    expect(wrapper.find('[data-testid="bulk-bar"]').text()).toContain("2 Dokumente ausgewählt");
    await wrapper.find('[data-testid="bulk-approve"]').trigger("click");
    await flushPromises();

    expect(post.mock.calls.map((c) => c[0]).sort()).toEqual(["/inbox/1/approve", "/inbox/2/approve"]);
    expect(wrapper.find('[data-testid="bulk-result"]').text()).toBe("1 genehmigt · 1 fehlgeschlagen.");
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toContainEqual(["inbox"]);
    expect(keys).toContainEqual(["library"]);
  });

  it("offers load-more while rows remain", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.resolve({ username: "admin" });
      if (path.startsWith("/inbox/?page=1")) {
        return Promise.resolve({ results: [inboxItem(1)], total: 2, page: 1, page_size: 50 });
      }
      if (path.startsWith("/inbox/?page=2")) {
        return Promise.resolve({ results: [inboxItem(2)], total: 2, page: 2, page_size: 50 });
      }
      return new Promise(() => undefined);
    });
    const wrapper = await mountSuspended(ReviewTab);
    await vi.waitFor(() => expect(wrapper.text()).toContain("1 von 2 geladen"));
    await wrapper.find('[data-testid="load-more"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("Beleg 2"));
    expect(wrapper.find('[data-testid="load-more"]').exists()).toBe(false);
  });
});
