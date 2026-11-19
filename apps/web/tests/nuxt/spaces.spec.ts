import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppNav from "~/components/AppNav.vue";
import MoveControl from "~/components/spaces/MoveControl.vue";
import AktenPage from "~/pages/akten.vue";
import LibraryPage from "~/pages/library/index.vue";
import UploadPage from "~/pages/upload.vue";

const { get, post, patch, del, upload } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  upload: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch, put: vi.fn(), upload, del }));

const PERSONAL = { id: 1, name: "Persönlich", kind: "personal", role: "owner", owner: "alice", member_count: 1, document_count: 4 };
const HAUSHALT = { id: 7, name: "Haushalt", kind: "shared", role: "owner", owner: "alice", member_count: 2, document_count: 0 };
const BOBS = { id: 8, name: "Bobs Akte", kind: "shared", role: "editor", owner: "bob", member_count: 2, document_count: 3 };
const LESEN = { id: 9, name: "Nur lesen", kind: "shared", role: "viewer", owner: "bob", member_count: 2, document_count: 1 };

let spaceList: Record<string, unknown>;

function single() {
  spaceList = { household_member_count: 1, spaces: [PERSONAL] };
}

function shared() {
  spaceList = { household_member_count: 2, spaces: [PERSONAL, HAUSHALT, BOBS, LESEN] };
}

function libraryItem(id: number, space: Record<string, unknown> | null) {
  return {
    id,
    title: `Dokument ${id}`,
    original_file_name: null,
    created: "2026-01-01",
    added: null,
    correspondent: "Stadtwerke",
    document_type: "Rechnung",
    lifecycle_tags: ["ai-propagated"],
    tags: [],
    ai_error_message: null,
    is_processing: false,
    home_space: space,
  };
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, patch, del, upload]) fn.mockReset();
  shared();
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "alice" });
    if (path === "/spaces") return Promise.resolve(spaceList);
    if (path === "/household/directory") {
      return Promise.resolve([
        { id: 1, username: "alice" },
        { id: 2, username: "bob" },
        { id: 3, username: "carol" },
      ]);
    }
    if (path === "/spaces/7/members") {
      return Promise.resolve([
        { member_id: 1, username: "alice", role: "owner" },
        { member_id: 2, username: "bob", role: "editor" },
      ]);
    }
    if (path === "/spaces/8/members") {
      return Promise.resolve([
        { member_id: 2, username: "bob", role: "owner" },
        { member_id: 1, username: "alice", role: "editor" },
      ]);
    }
    if (path.startsWith("/library/")) {
      return Promise.resolve({
        results: [
          libraryItem(1, { id: 1, name: "Persönlich", kind: "personal" }),
          libraryItem(2, { id: 8, name: "Bobs Akte", kind: "shared" }),
        ],
        total: 2,
        page: 1,
        page_size: 25,
      });
    }
    return new Promise(() => undefined);
  });
});

describe("space UI is hidden for a household of one", () => {
  it("no nav entry, no library column/filter/selection, no upload picker, no move", async () => {
    single();
    useNuxtApp().$queryClient.setQueryData(ME_KEY, { username: "alice" });

    const nav = await mountSuspended(AppNav);
    await vi.waitFor(() => expect(nav.html()).toContain("<nav"));
    await flushPromises();
    expect(nav.text()).not.toContain("Akten");

    const library = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(library.text()).toContain("Dokument 1"));
    await flushPromises();
    expect(library.find('[data-testid="space-filter"]').exists()).toBe(false);
    expect(library.find('[data-testid="row-space"]').exists()).toBe(false);
    expect(library.find('[data-testid="select-all"]').exists()).toBe(false);

    const uploadPage = await mountSuspended(UploadPage, { route: "/upload" });
    await flushPromises();
    expect(uploadPage.find('[data-testid="upload-space"]').exists()).toBe(false);

    const move = await mountSuspended(MoveControl, {
      props: { docId: 12, space: { id: 1, name: "Persönlich", kind: "personal", owner: "alice" } },
    });
    await flushPromises();
    expect(move.find('[data-testid="move-control"]').exists()).toBe(false);

    const akten = await mountSuspended(AktenPage, { route: "/akten" });
    await vi.waitFor(() => expect(akten.find('[data-testid="akten-single"]').exists()).toBe(true));
  });

  it("the nav shows Akten once a second member exists", async () => {
    useNuxtApp().$queryClient.setQueryData(ME_KEY, { username: "alice" });
    const nav = await mountSuspended(AppNav);
    await vi.waitFor(() => expect(nav.text()).toContain("Akten"));
  });
});

describe("/akten", () => {
  async function render() {
    const wrapper = await mountSuspended(AktenPage, { route: "/akten" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="akte-7"]').exists()).toBe(true));
    await flushPromises();
    return wrapper;
  }

  it("owner manages; editor and viewer can only leave; delete is disabled while not empty", async () => {
    const wrapper = await render();
    const own = wrapper.find('[data-testid="akte-7"]');
    expect(own.find('[data-testid="akte-rename"]').exists()).toBe(true);
    expect(own.find('[data-testid="akte-delete"]').attributes("disabled")).toBeUndefined();
    expect(own.find('[data-testid="akte-leave"]').exists()).toBe(false);

    for (const id of [8, 9]) {
      const other = wrapper.find(`[data-testid="akte-${id}"]`);
      expect(other.find('[data-testid="akte-rename"]').exists()).toBe(false);
      expect(other.find('[data-testid="akte-delete"]').exists()).toBe(false);
      expect(other.find('[data-testid="akte-leave"]').exists()).toBe(true);
    }
    // Personal space: no management at all.
    expect(wrapper.find('[data-testid="akte-1"]').find("button").exists()).toBe(false);
    expect(wrapper.find('[data-testid="akte-1"]').text()).toContain("Meine persönliche Akte");
  });

  it("creates a space and deletes an empty one", async () => {
    post.mockResolvedValue({ ...HAUSHALT, id: 10, name: "Auto" });
    del.mockResolvedValue(undefined);
    const wrapper = await render();

    await wrapper.find('[data-testid="akte-name"]').setValue("Auto");
    await wrapper.find('[data-testid="akte-create"]').trigger("submit");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/spaces", { name: "Auto" });

    await wrapper.find('[data-testid="akte-7"] [data-testid="akte-delete"]').trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/spaces/7");
  });

  it("the owner adds a member from the directory and changes a role", async () => {
    post.mockResolvedValue({ member_id: 3, username: "carol", role: "viewer" });
    patch.mockResolvedValue({ member_id: 2, username: "bob", role: "viewer" });
    const wrapper = await render();
    await wrapper.find('[data-testid="akte-7"] [data-testid="akte-members-toggle"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="space-member-row"]')).toHaveLength(2));
    await flushPromises();

    const pick = wrapper.find('[data-testid="space-member-pick"]');
    expect(pick.findAll("option").map((o) => o.text())).toEqual(["Mitglied wählen…", "carol"]);
    await pick.setValue("3");
    await wrapper.find('[data-testid="space-member-add"] select:nth-of-type(2)').setValue("viewer");
    await wrapper.find('[data-testid="space-member-add"]').trigger("submit");
    await flushPromises();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/spaces/7/members", { member_id: 3, role: "viewer" }));

    await wrapper.find('[data-testid="space-member-role"]').setValue("viewer");
    await flushPromises();
    expect(patch).toHaveBeenCalledWith("/spaces/7/members/2", { role: "viewer" });
  });

  it("an editor sees members read-only and can leave", async () => {
    del.mockResolvedValue(undefined);
    const wrapper = await render();
    await wrapper.find('[data-testid="akte-8"] [data-testid="akte-members-toggle"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="space-member-row"]')).toHaveLength(2));
    expect(wrapper.find('[data-testid="space-member-role"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="space-member-add"]').exists()).toBe(false);

    await wrapper.find('[data-testid="akte-8"] [data-testid="akte-leave"]').trigger("click");
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith("/spaces/8/members/1"));
  });
});

describe("upload space picker", () => {
  it("lists owner/editor spaces, defaults to personal (no space_id), sends the chosen space", async () => {
    upload.mockResolvedValue({ results: [] });
    const wrapper = await mountSuspended(UploadPage, { route: "/upload" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="upload-space"]').exists()).toBe(true));
    const select = wrapper.find('[data-testid="upload-space"]');
    expect(select.findAll("option").map((o) => o.text())).toEqual(["Meine persönliche Akte", "Bobs Akte", "Haushalt"]);

    const file = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    const input = wrapper.find('[data-testid="file-input"]');
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect((upload.mock.calls[0]![1] as FormData).get("space_id")).toBeNull();

    await select.setValue("7");
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect((upload.mock.calls[1]![1] as FormData).get("space_id")).toBe("7");
  });
});

describe("moving documents", () => {
  it("library: Akte column and filter, multi-select bulk move with a result summary", async () => {
    post.mockResolvedValue({
      results: [
        { doc_id: 1, status: "moved" },
        { doc_id: 2, status: "forbidden", detail: "Nur der Eigentümer…" },
      ],
    });
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="select-all"]').exists()).toBe(true));
    expect(wrapper.findAll('[data-testid="row-space"]').map((c) => c.text())).toEqual(["Meine persönliche Akte", "Bobs Akte"]);
    expect(wrapper.find('[data-testid="space-filter"]').findAll("option")).toHaveLength(5);

    await wrapper.find('[data-testid="select-all"]').trigger("change");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="move-bar"]').text()).toContain("2 ausgewählt"));
    await wrapper.find('[data-testid="move-target"]').setValue("7");
    await wrapper.find('[data-testid="move-submit"]').trigger("click");
    await flushPromises();

    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/spaces/7/documents", { doc_ids: [1, 2] }));
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="move-result"]').text()).toBe("1 verschoben · 1 nicht erlaubt"),
    );
    // The refused document stays selected.
    expect(wrapper.find('[data-testid="move-bar"]').text()).toContain("1 ausgewählt");
  });

  it("the space filter goes to the URL", async () => {
    const wrapper = await mountSuspended(LibraryPage, { route: "/library" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="space-filter"]').exists()).toBe(true));
    await wrapper.find('[data-testid="space-filter"]').setValue("7");
    await vi.waitFor(() => expect(useRoute().query.space).toBe("7"));
  });

  it("detail: Verschieben only for the owner of the current space, into the other placeable spaces", async () => {
    post.mockResolvedValue({ doc_id: 12, status: "moved" });
    const owned = await mountSuspended(MoveControl, {
      props: { docId: 12, space: { id: 1, name: "Persönlich", kind: "personal", owner: "alice" } },
    });
    await vi.waitFor(() => expect(owned.find('[data-testid="move-open"]').exists()).toBe(true));
    await owned.find('[data-testid="move-open"]').trigger("click");
    const options = owned.find('[data-testid="move-select"]').findAll("option").map((o) => o.text());
    expect(options).toEqual(["In Akte…", "Bobs Akte", "Haushalt"]);
    await owned.find('[data-testid="move-select"]').setValue("7");
    await owned.find('[data-testid="move-confirm"]').trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/documents/12/move", { space_id: 7 }));

    for (const space of [
      { id: 8, name: "Bobs Akte", kind: "shared", owner: "bob" },
      { id: 9, name: "Nur lesen", kind: "shared", owner: "bob" },
    ] as const) {
      const other = await mountSuspended(MoveControl, { props: { docId: 13, space } });
      await flushPromises();
      expect(other.find('[data-testid="move-control"]').exists()).toBe(false);
    }
  });
});
