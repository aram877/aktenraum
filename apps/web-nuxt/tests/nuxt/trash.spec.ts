import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TrashPage from "~/pages/trash.vue";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));

const ITEM = {
  id: 9,
  title: "Alte Rechnung",
  original_file_name: null,
  created: null,
  deleted_at: new Date().toISOString(),
  correspondent: null,
  document_type: "Rechnung",
  ai_correspondent: "Stadtwerke",
  ai_document_type: null,
  ai_summary_de: null,
};

describe("trash page", () => {
  beforeEach(() => {
    useNuxtApp().$queryClient.clear();
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ results: [ITEM], total: 1, page: 1, page_size: 20 });
    post.mockResolvedValue(undefined);
  });

  it("lists trashed documents with fallbacks to the AI fields", async () => {
    const wrapper = await mountSuspended(TrashPage);
    await vi.waitFor(() => expect(wrapper.text()).toContain("Alte Rechnung"));
    expect(wrapper.text()).toContain("Rechnung · Stadtwerke · noch 30 Tage");
  });

  it("asks for confirmation before deleting permanently", async () => {
    const wrapper = await mountSuspended(TrashPage);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="delete-9"]').exists()).toBe(true));
    await wrapper.find('[data-testid="delete-9"]').trigger("click");
    expect(post).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="delete-9"]').text()).toBe("Wirklich?");
    await wrapper.find('[data-testid="delete-9"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/trash/9/delete", {});
  });

  it("invalidates the trash and library caches after a restore", async () => {
    const queryClient = useNuxtApp().$queryClient;
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = await mountSuspended(TrashPage);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="restore-9"]').exists()).toBe(true));
    await wrapper.find('[data-testid="restore-9"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/trash/9/restore", {});
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
    expect(keys).toContainEqual(["trash"]);
    expect(keys).toContainEqual(["library"]);
  });
});
