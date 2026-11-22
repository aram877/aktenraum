import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    await wrapper.find('select[name="status"]').setValue("error");
    await flushPromises();
    await vi.waitFor(() => expect(useRoute().query).toEqual({ status: "error" }));
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

  it("renders compact rows: type tile, star + '+N' tags, no status for finished documents", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.resolve({ username: "admin" });
      if (path === "/library/tags") return Promise.resolve({ results: [] });
      if (path.startsWith("/library/")) {
        return Promise.resolve({
          results: [
            libraryItem(1, { tags: ["ai-propagated", "strom", "wichtig", "wohnung", "2026"] }),
            libraryItem(2, {
              document_type: "Bußgeldbescheid",
              lifecycle_tags: ["ai-error"],
              tags: ["ai-error"],
              created: "2025-12-03",
            }),
          ],
          total: 2,
          page: 1,
          page_size: 25,
        });
      }
      return new Promise(() => undefined);
    });
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="library-row"]')).toHaveLength(2));
    const [first, second] = wrapper.findAll('[data-testid="library-row"]');
    expect(first!.find('[data-testid="doc-type-tile"]').text()).toBe("RE");
    expect(first!.find('[data-testid="row-tags-more"]').text()).toBe("+3");
    expect(first!.text()).not.toContain("wohnung");
    expect(first!.find('[data-testid="row-status"]').exists()).toBe(false);
    expect(second!.find('[data-testid="doc-type-tile"]').attributes("data-family")).toBe("mobil");
    expect(second!.find('[data-testid="row-status"]').text()).toBe("Fehler");
    expect(wrapper.findAll('[data-testid="library-group"] h2').map((h) => h.text())).toEqual([
      "Januar 2026",
      "Dezember 2025",
    ]);
  });

  it("shows the review tab when the URL asks for it", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?tab=review" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Zur Prüfung"));
    expect(wrapper.find('[data-testid="library-total"]').exists()).toBe(false);
  });
});

describe("preview panel (wide screens)", () => {
  const original = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.resolve({ username: "admin" });
      if (path === "/library/tags" || path === "/library/types") return Promise.resolve({ results: [] });
      if (path.startsWith("/library/")) {
        return Promise.resolve({ results: [libraryItem(1), libraryItem(2)], total: 2, page: 1, page_size: 25 });
      }
      const detail = /^\/documents\/(\d+)\/detail$/.exec(path);
      if (detail) {
        return Promise.resolve({ id: Number(detail[1]), ai_summary_de: `Zusammenfassung ${detail[1]}`, type_fields: {}, tags: [] });
      }
      return new Promise(() => undefined);
    });
  });

  afterEach(() => {
    window.matchMedia = original;
  });

  it("a click previews the row without leaving the list; double-click opens it", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="library-preview"]').text()).toContain("Dokument 1"));

    await wrapper.findAll('[data-testid="library-row"] a')[1]!.trigger("click", { button: 0 });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="library-preview"]').text()).toContain("Dokument 2"));
    await vi.waitFor(() => expect(wrapper.find('[data-testid="library-preview"]').text()).toContain("Zusammenfassung 2"));
    expect(useRoute().path).toBe("/library");

    await wrapper.findAll('[data-testid="library-row"] a')[1]!.trigger("dblclick");
    await vi.waitFor(() => expect(useRoute().path).toBe("/library/2"));
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

describe("status filter", () => {
  it("sends status from the URL and resets paging when it changes", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?status=error&page=3" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    expect(libraryCalls()[0]).toContain("status=error");
    expect((wrapper.find('select[name="status"]').element as HTMLSelectElement).value).toBe("error");

    await wrapper.find('select[name="status"]').setValue("done");
    await vi.waitFor(() => expect(useRoute().query).toEqual({ status: "done" }));
  });

  it("switches to the review tab for 'In Prüfung'", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    await wrapper.find('select[name="status"]').setValue("review");
    await vi.waitFor(() => expect(useRoute().query).toEqual({ tab: "review" }));
  });

  it("ignores an unknown status in the URL", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?status=bogus" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    expect(libraryCalls()[0]).not.toContain("status=");
  });

  it("asks for confirmation before reprocessing every failed document", async () => {
    post.mockResolvedValue({ requested: 60, reprocessed: 59, failed: [{ doc_id: 9, detail: "x" }], remaining: 0 });
    const invalidate = vi.spyOn(useNuxtApp().$queryClient, "invalidateQueries");
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?status=error" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="bulk-reprocess"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="bulk-reprocess"]').text()).toContain("(60)");

    await wrapper.find('[data-testid="bulk-reprocess"]').trigger("click");
    expect(post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="bulk-reprocess"]').text()).toContain("Wirklich 60");

    await wrapper.find('[data-testid="bulk-reprocess"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/documents/reprocess-failed", {});
    expect(wrapper.find('[data-testid="bulk-result"]').text()).toBe("59 neu gestartet · 1 fehlgeschlagen");
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toContainEqual(["library"]);
  });

  it("does not offer bulk reprocess outside the Fehler filter", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Dokument 1"));
    expect(wrapper.find('[data-testid="bulk-reprocess"]').exists()).toBe(false);
  });
});

describe("document type chips", () => {
  beforeEach(() => {
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.resolve({ username: "admin" });
      if (path === "/library/types") {
        return Promise.resolve({ results: [{ name: "Gehaltsabrechnung", count: 83 }, { name: "Rechnung", count: 48 }] });
      }
      if (path === "/library/tags") return Promise.resolve({ results: [] });
      if (path.startsWith("/library/")) {
        return Promise.resolve({ results: [libraryItem(1)], total: 1, page: 1, page_size: 25 });
      }
      return new Promise(() => undefined);
    });
  });

  it("shows one chip per area with its count and filters by the area's types", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?page=2" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="family-arbeit"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="family-arbeit"]').text()).toContain("83");
    expect(wrapper.find('[data-testid="family-geld"]').text()).toContain("48");
    await wrapper.find('[data-testid="family-arbeit"]').trigger("click");
    await vi.waitFor(() => expect(useRoute().query).toEqual({ family: "arbeit" }));
    await vi.waitFor(() =>
      expect(libraryCalls().at(-1)).toContain("document_type=Gehaltsabrechnung&document_type=Lohnsteuerbescheinigung"),
    );
    await vi.waitFor(() => expect(wrapper.find('[data-testid="type-facet"]').text()).toContain("Gehaltsabrechnung"));
  });

  it("narrows to one type and clears it again", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library?family=geld" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="type-facet"]').exists()).toBe(true));
    await wrapper.find('[data-testid="type-facet"] button').trigger("click");
    await vi.waitFor(() => expect(useRoute().query).toEqual({ family: "geld", document_type: "Rechnung" }));
    await vi.waitFor(() => expect(libraryCalls().at(-1)).toMatch(/document_type=Rechnung(&|$)/));
    await wrapper.find('[data-testid="type-facet"] button').trigger("click");
    await vi.waitFor(() => expect(useRoute().query).toEqual({ family: "geld" }));
    await wrapper.find('[data-testid="family-geld"]').trigger("click");
    await vi.waitFor(() => expect(useRoute().query).toEqual({}));
  });
});
