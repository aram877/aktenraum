import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppNav from "~/components/AppNav.vue";
import SharePanel from "~/components/shares/SharePanel.vue";
import { endOfLocalDay, localDayOf, auditLabel } from "~/composables/useShares";
import GeteiltPage from "~/pages/geteilt.vue";
import InboxDetailPage from "~/pages/inbox/[id].vue";
import LibraryDetailPage from "~/pages/library/[id].vue";

const { get, post, patch, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch, put: vi.fn(), upload: vi.fn(), del }));

const PERSONAL = { id: 1, name: "Persönlich", kind: "personal", role: "owner", owner: "alice", member_count: 1, document_count: 4 };

let householdSize = 2;
let docAccess: Record<string, unknown> = {};

function detail(id: number) {
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
    ai_confidence_reason: null,
    content_excerpt: "",
    tags: [],
    type_fields: null,
    home_space: { id: 1, name: "Persönlich", kind: "personal", owner: "alice" },
    shared_by: null,
    access: { via: "space", role: "owner" },
    ...docAccess,
  };
}

const SHARED_WITH_BOB = {
  member_id: 2,
  username: "bob",
  role: "viewer",
  expires_at: null,
  granted_at: "2026-11-20T10:00:00Z",
  granted_by: "alice",
};

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, patch, del]) fn.mockReset();
  householdSize = 2;
  docAccess = {};
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "alice" });
    if (path === "/spaces") return Promise.resolve({ household_member_count: householdSize, spaces: [PERSONAL] });
    if (path === "/household/directory") {
      return Promise.resolve([
        { id: 1, username: "alice" },
        { id: 2, username: "bob" },
        { id: 3, username: "carol" },
      ]);
    }
    if (path === "/spaces/1/members") return Promise.resolve([{ member_id: 1, username: "alice", role: "owner" }]);
    if (path === "/documents/12/shares") return Promise.resolve([SHARED_WITH_BOB]);
    if (path === "/documents/12/shares/audit") {
      return Promise.resolve([
        { id: 2, member_id: 2, member: "bob", actor: "bob", event: "accessed", access_kind: "download", at: "2026-11-20T11:00:00Z" },
        { id: 1, member_id: 2, member: "bob", actor: "alice", event: "granted", access_kind: null, at: "2026-11-20T10:00:00Z" },
      ]);
    }
    if (/^\/documents\/\d+\/detail$/.test(path) || /^\/inbox\/\d+$/.test(path)) {
      return Promise.resolve(detail(Number(/(\d+)/.exec(path)?.[1])));
    }
    if (path.startsWith("/inbox/?")) return Promise.resolve({ results: [], total: 0, page: 1, page_size: 50 });
    if (path === "/shares/with-me") {
      return Promise.resolve([{ doc_id: 42, title: "Kreditvertrag", shared_by: "alice", role: "viewer", expires_at: "2026-12-31T22:59:59Z" }]);
    }
    if (path === "/shares/by-me") {
      return Promise.resolve([
        { doc_id: 12, title: "Gehaltsabrechnung", member: { id: 2, username: "bob" }, role: "editor", expires_at: null, granted_at: "2026-11-20T10:00:00Z" },
      ]);
    }
    return new Promise(() => undefined);
  });
  post.mockResolvedValue({});
  patch.mockResolvedValue({});
  del.mockResolvedValue(undefined);
});

describe("share helpers", () => {
  it("sends the end of the chosen local day and reads it back", () => {
    const iso = endOfLocalDay("2026-12-31")!;
    const local = new Date(iso);
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()]).toEqual([2026, 11, 31, 23, 59]);
    expect(localDayOf(iso)).toBe("2026-12-31");
    expect(endOfLocalDay("")).toBeNull();
    expect(localDayOf(null)).toBe("");
  });

  it("labels audit entries", () => {
    expect(auditLabel({ id: 1, member_id: 2, member: "bob", actor: "bob", event: "accessed", access_kind: "download", at: "" })).toBe("bob – Download");
    expect(auditLabel({ id: 1, member_id: 2, member: "bob", actor: "alice", event: "granted", access_kind: null, at: "" })).toBe("Geteilt: bob (durch alice)");
    expect(auditLabel({ id: 1, member_id: 2, member: "bob", actor: null, event: "expired", access_kind: null, at: "" })).toBe("Abgelaufen: bob");
  });
});

describe("SharePanel", () => {
  it("lists shares, offers only members outside the space and not yet shared with, grants and revokes", async () => {
    const wrapper = await mountSuspended(SharePanel, { props: { docId: 12, spaceId: 1 } });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="share-2"]').exists()).toBe(true));
    const options = wrapper.findAll('select[name="share-member"] option').map((o) => o.text());
    expect(options).toEqual(["wählen…", "carol"]);

    await wrapper.find('select[name="share-member"]').setValue("3");
    await wrapper.find('select[name="share-role"]').setValue("editor");
    await wrapper.find('input[name="share-expiry"]').setValue("2099-12-31");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/documents/12/shares", {
      member_id: 3,
      role: "editor",
      expires_at: endOfLocalDay("2099-12-31"),
    });

    await wrapper.find('[data-testid="revoke-2"]').trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/documents/12/shares/2");
  });

  it("changes the role and shows the audit log on demand", async () => {
    const wrapper = await mountSuspended(SharePanel, { props: { docId: 12, spaceId: 1 } });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="share-2"]').exists()).toBe(true));
    await wrapper.find('[data-testid="share-2"] select').setValue("editor");
    await flushPromises();
    expect(patch).toHaveBeenCalledWith("/documents/12/shares/2", { role: "editor" });

    expect(get).not.toHaveBeenCalledWith("/documents/12/shares/audit");
    await wrapper.find('[data-testid="toggle-audit"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="share-audit"]').text()).toContain("bob – Download"));
  });
});

describe("library detail page", () => {
  it("the home-space owner sees the share panel", async () => {
    const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/12" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="share-panel"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="reprocess"]').exists()).toBe(true);
  });

  it("a space editor doesn't, and nobody does in a household of one", async () => {
    docAccess = { access: { via: "space", role: "editor" } };
    const editor = await mountSuspended(LibraryDetailPage, { route: "/library/12" });
    await vi.waitFor(() => expect(editor.find('[data-testid="save"]').exists()).toBe(true));
    await flushPromises();
    expect(editor.find('[data-testid="share-panel"]').exists()).toBe(false);
    editor.unmount();

    useNuxtApp().$queryClient.clear();
    docAccess = {};
    householdSize = 1;
    const single = await mountSuspended(LibraryDetailPage, { route: "/library/13" });
    await vi.waitFor(() => expect(single.find('[data-testid="save"]').exists()).toBe(true));
    await flushPromises();
    expect(single.find('[data-testid="share-panel"]').exists()).toBe(false);
  });

  it("an editor share edits fields but sees no state actions and no share panel", async () => {
    docAccess = {
      home_space: null,
      shared_by: { username: "alice", role: "editor", expires_at: null },
      access: { via: "share", role: "editor" },
    };
    const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/14" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-space"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="home-space"]').text()).toContain("Geteilt von alice");
    expect(wrapper.find('[data-testid="save"]').exists()).toBe(true);
    for (const id of ["reprocess", "delete", "share-panel"]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    }
    expect(wrapper.find('input[name="ai_title"]').attributes("readonly")).toBeUndefined();
  });

  it("a viewer share gets read-only fields", async () => {
    docAccess = {
      home_space: null,
      shared_by: { username: "alice", role: "viewer", expires_at: "2026-12-31T22:59:59Z" },
      access: { via: "share", role: "viewer" },
    };
    const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/15" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-space"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="home-space"]').text()).toContain("bis");
    expect(wrapper.find('[data-testid="save"]').exists()).toBe(false);
    expect(wrapper.find('input[name="ai_title"]').attributes("readonly")).toBeDefined();
    expect(wrapper.find('select[name="ai_document_type"]').attributes("disabled")).toBeDefined();
  });

  it("the review page hides approve/reject for share access", async () => {
    docAccess = { home_space: null, shared_by: { username: "alice", role: "editor", expires_at: null }, access: { via: "share", role: "editor" } };
    const wrapper = await mountSuspended(InboxDetailPage, { route: "/inbox/16" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="home-space"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="reject"]').exists()).toBe(false);
  });
});

describe("/geteilt", () => {
  it("lists what was shared with me, with sharer, role and expiry", async () => {
    const wrapper = await mountSuspended(GeteiltPage, { route: "/geteilt" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="with-me-42"]').exists()).toBe(true));
    const text = wrapper.find('[data-testid="with-me-42"]').text();
    expect(text).toContain("Kreditvertrag");
    expect(text).toContain("Geteilt von alice");
    expect(text).toContain("Ansehen");
    expect(text).toContain("bis");
  });

  it("lists what I shared and revokes inline", async () => {
    const wrapper = await mountSuspended(GeteiltPage, { route: "/geteilt?tab=by-me" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="by-me-12-2"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="by-me-12-2"]').text()).toContain("mit bob");
    await wrapper.find('[data-testid="revoke-12-2"]').trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/documents/12/shares/2");
  });

  it("explains itself in a household of one", async () => {
    householdSize = 1;
    const wrapper = await mountSuspended(GeteiltPage, { route: "/geteilt" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="geteilt-single"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="tab-with-me"]').exists()).toBe(false);
  });
});

describe("nav", () => {
  it("shows Geteilt only with a second member", async () => {
    const wrapper = await mountSuspended(AppNav);
    await vi.waitFor(() => expect(wrapper.text()).toContain("Geteilt"));
    wrapper.unmount();

    useNuxtApp().$queryClient.clear();
    householdSize = 1;
    const single = await mountSuspended(AppNav);
    await vi.waitFor(() => expect(single.text()).toContain("Bibliothek"));
    await flushPromises();
    expect(single.text()).not.toContain("Geteilt");
  });
});
