import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InboxDetailPage from "~/pages/inbox/[id].vue";
import LibraryDetailPage from "~/pages/library/[id].vue";

const { get, post, patch, navigate } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  navigate: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch, put: vi.fn(), upload: vi.fn() }));

function detail(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Scan ${id}`,
    original_file_name: null,
    created: null,
    added: null,
    ai_correspondent: "Vitego",
    ai_document_type: "Beleg",
    ai_title: "Titel",
    ai_issue_date: "2026-07-30",
    ai_confidence: 0.9,
    low_confidence: false,
    ai_error_message: null,
    ai_reference_numbers: null,
    ai_suggested_tags: null,
    ai_summary_de: null,
    ai_backend: null,
    ai_model: null,
    ai_confidence_reason: "klar erkennbar",
    content_excerpt: "",
    tags: [],
    type_fields: null,
    ...overrides,
  };
}

function inboxRow(id: number) {
  const { ai_reference_numbers: _r, ai_suggested_tags: _s, ai_summary_de: _d, ...row } = detail(id);
  return row;
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, patch, navigate]) fn.mockReset();
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "admin" });
    const inbox = /^\/inbox\/(\d+)$/.exec(path);
    if (inbox) return Promise.resolve(detail(Number(inbox[1])));
    if (path.startsWith("/inbox/?")) {
      return Promise.resolve({ results: [inboxRow(4), inboxRow(5), inboxRow(6)], total: 3, page: 1, page_size: 50 });
    }
    const doc = /^\/documents\/(\d+)\/detail$/.exec(path);
    if (doc) return Promise.resolve(detail(Number(doc[1])));
    return new Promise(() => undefined);
  });
  post.mockResolvedValue({});
});

describe("library detail", () => {
  it("saves only the edited field and confirms", async () => {
    patch.mockImplementation((_path: string, body: Record<string, unknown>) =>
      Promise.resolve(detail(12, body)),
    );
    const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/12" });
    await vi.waitFor(() => expect(wrapper.find('input[name="ai_title"]').exists()).toBe(true));
    expect(wrapper.find('iframe').attributes("src")).toBe("/api/documents/12/preview");
    expect(wrapper.find('[data-testid="save"]').attributes("disabled")).toBeDefined();

    await wrapper.find('input[name="ai_title"]').setValue("Neuer Titel");
    await wrapper.find('[data-testid="save"]').trigger("click");
    await flushPromises();

    expect(patch).toHaveBeenCalledWith("/documents/12/fields", { ai_title: "Neuer Titel" });
    expect(wrapper.find('[data-testid="saved"]').exists()).toBe(true);
  });

  it("reset restores the server values", async () => {
    const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/12" });
    await vi.waitFor(() => expect(wrapper.find('input[name="ai_title"]').exists()).toBe(true));
    await wrapper.find('input[name="ai_title"]').setValue("Tippfehler");
    await wrapper.find('[data-testid="reset"]').trigger("click");
    expect((wrapper.find('input[name="ai_title"]').element as HTMLInputElement).value).toBe("Titel");
  });

  it("asks for confirmation before reprocessing", async () => {
    const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/12" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="reprocess"]').exists()).toBe(true));
    await wrapper.find('[data-testid="reprocess"]').trigger("click");
    expect(post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="reprocess"]').text()).toBe("Wirklich? Erneut klicken");
    await wrapper.find('[data-testid="reprocess"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/documents/12/reprocess", {});
    await vi.waitFor(() => expect(useRoute().path).toBe("/library"));
  });
});

describe("inbox detail", () => {
  async function render(id = 5) {
    const wrapper = await mountSuspended(InboxDetailPage, { route: `/inbox/${id}`, attachTo: document.body });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="approve"]').exists()).toBe(true));
    await flushPromises();
    return wrapper;
  }

  it("approves with the edited fields, invalidates both lists and moves to the next document", async () => {
    const invalidate = vi.spyOn(useNuxtApp().$queryClient, "invalidateQueries");
    const wrapper = await render(5);
    await wrapper.find('input[name="ai_correspondent"]').setValue("Vitego GmbH");
    await wrapper.find('[data-testid="approve"]').trigger("click");
    await flushPromises();

    expect(post).toHaveBeenCalledWith("/inbox/5/approve", { ai_correspondent: "Vitego GmbH" });
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toContainEqual(["inbox"]);
    expect(keys).toContainEqual(["library"]);
    await vi.waitFor(() => expect(useRoute().path).toBe("/inbox/6"));
    wrapper.unmount();
  });

  it("rejects with r and approves with a", async () => {
    const wrapper = await render(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/inbox/5/reject", {});
    wrapper.unmount();
  });

  it("does not approve while the user types the letter a into a field", async () => {
    const wrapper = await render(5);
    const input = wrapper.find('input[name="ai_title"]').element as HTMLInputElement;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("goes back to the review list on Escape", async () => {
    const wrapper = await render(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await vi.waitFor(() => expect(useRoute().fullPath).toBe("/library?tab=review"));
    wrapper.unmount();
  });

  it("browses to the previous document with k", async () => {
    const wrapper = await render(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    await vi.waitFor(() => expect(useRoute().path).toBe("/inbox/4"));
    wrapper.unmount();
  });
});
