import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import Mitglieder from "~/components/settings/Mitglieder.vue";
import {
  REMOVALS_KEY,
  REMOVALS_POLL_MS,
  REMOVAL_PREVIEW_KEY,
  useRemovalPreview,
  useRemovals,
  useRemoveMember,
  type RemovalEntry,
} from "~/composables/useHousehold";

const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put: vi.fn(), upload: vi.fn(), del }));

const MEMBERS = [
  { id: 1, username: "aram", role: "admin", joined_at: "2026-05-01T10:00:00Z" },
  { id: 2, username: "bob", role: "member", joined_at: "2026-11-19T10:00:00Z" },
  { id: 3, username: "carol", role: "member", joined_at: "2026-11-19T10:00:00Z" },
];

const PREVIEW = {
  member_id: 2,
  username: "bob",
  successor_member_id: 1,
  successor: "aram",
  documents: 30,
  trashed: 1,
  spaces_owned: [{ id: 9, name: "Wohnung" }],
  spaces_left: [{ id: 4, name: "Haushalt" }],
  shares_revoked: 2,
  shares_kept: 1,
};

function removal(status: RemovalEntry["status"]): RemovalEntry {
  return { member_id: 2, username: "bob", successor: "aram", removed_at: "2026-11-20T10:00:00Z", status, last_error: null };
}

function serve(removals: () => RemovalEntry[] = () => []) {
  get.mockImplementation((path: string) => {
    if (path === "/household/members") return Promise.resolve(MEMBERS);
    if (path === "/household/invites") return Promise.resolve([]);
    if (path === "/household/removals") return Promise.resolve(removals());
    if (path.startsWith("/household/members/2/removal-preview")) {
      const successor = /successor=(\d+)/.exec(path)?.[1];
      return Promise.resolve(successor === "3" ? { ...PREVIEW, successor_member_id: 3, successor: "carol" } : PREVIEW);
    }
    return new Promise(() => undefined);
  });
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, del]) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs a composable inside a component so vue-query has its client. */
async function withComposable<T>(setup: () => T): Promise<T> {
  let out: T | undefined;
  await mountSuspended(defineComponent({ setup: () => { out = setup(); return () => h("div"); } }));
  return out as T;
}

describe("removal composables", () => {
  it("keys the preview by member and successor and only runs with a member", async () => {
    serve();
    const memberId = ref<number | null>(null);
    const successorId = ref<number | null>(3);
    const preview = await withComposable(() => useRemovalPreview(memberId, successorId));
    await flushPromises();
    expect(get).not.toHaveBeenCalled();
    memberId.value = 2;
    await vi.waitFor(() => expect(preview.data.value?.successor).toBe("carol"));
    expect(get).toHaveBeenCalledWith("/household/members/2/removal-preview?successor=3");
    expect(useNuxtApp().$queryClient.getQueryData([...REMOVAL_PREVIEW_KEY, 2, 3])).toMatchObject({ successor: "carol" });
  });

  it("the removal mutation sends the body and invalidates household, spaces, shares and library", async () => {
    post.mockResolvedValue({ member_id: 2, successor_member_id: 3, status: "done" });
    const client = useNuxtApp().$queryClient;
    const spy = vi.spyOn(client, "invalidateQueries");
    const mutation = await withComposable(() => useRemoveMember());
    await mutation.mutateAsync({ memberId: 2, confirmUsername: "bob", successorId: 3 });
    expect(post).toHaveBeenCalledWith("/household/members/2/remove", { confirm_username: "bob", successor_member_id: 3 });
    const keys = spy.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);
    expect(keys).toEqual(expect.arrayContaining([["household"], ["spaces"], ["shares"], ["library"]]));
  });

  it("polls the removal list every 10 s while one is completing, and stops once all are done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: RemovalEntry["status"] = "completing";
    serve(() => [removal(status)]);
    const removals = await withComposable(() => useRemovals(true));
    await vi.waitFor(() => expect(removals.data.value?.[0]?.status).toBe("completing"));
    const calls = () => get.mock.calls.filter(([p]) => p === "/household/removals").length;
    expect(calls()).toBe(1);
    status = "done";
    await vi.advanceTimersByTimeAsync(REMOVALS_POLL_MS);
    await vi.waitFor(() => expect(removals.data.value?.[0]?.status).toBe("done"));
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(REMOVALS_POLL_MS * 3);
    expect(calls()).toBe(2);
    expect(useNuxtApp().$queryClient.getQueryData(REMOVALS_KEY)).toEqual([removal("done")]);
  });
});

describe("Mitglieder: removing a member", () => {
  it("offers Entfernen for members only, not for the admin", async () => {
    serve();
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(3));
    const rows = wrapper.findAll('[data-testid="member-row"]');
    expect(rows[0]!.find('[data-testid="remove-member"]').exists()).toBe(false);
    expect(rows[1]!.find('[data-testid="remove-member"]').exists()).toBe(true);
    expect(rows[2]!.find('[data-testid="remove-member"]').exists()).toBe(true);
  });

  it("shows the preview, gates the confirm on the typed username and sends the chosen successor", async () => {
    serve();
    post.mockResolvedValue({ member_id: 2, successor_member_id: 3, status: "done" });
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="remove-member"]')).toHaveLength(2));
    await wrapper.findAll('[data-testid="remove-member"]')[0]!.trigger("click");

    const dialog = () => wrapper.find('[data-testid="remove-dialog"]');
    expect(dialog().exists()).toBe(true);
    const select = wrapper.find('[data-testid="remove-successor"]');
    expect((select.element as HTMLSelectElement).value).toBe("1"); // default: me
    expect(select.findAll("option").map((o) => o.text())).toEqual(["aram (ich)", "carol"]);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="remove-preview"]').exists()).toBe(true));
    const preview = wrapper.find('[data-testid="remove-preview"]').text();
    expect(preview).toContain("30 Dokumente gehen an aram (davon 1 im Papierkorb)");
    expect(preview).toContain("aram wird Eigentümer von „Wohnung“");
    expect(preview).toContain("bob verlässt „Haushalt“");
    expect(preview).toContain("2 Freigaben enden");
    expect(preview).toContain("1 Freigabe bleibt bestehen");

    await select.setValue("3");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="remove-preview"]').text()).toContain("an carol"));

    const submit = () => wrapper.find('[data-testid="remove-submit"]');
    expect(submit().attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="remove-confirm"]').setValue("bo");
    expect(submit().attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="remove-confirm"]').setValue("bob");
    expect(submit().attributes("disabled")).toBeUndefined();
    await submit().trigger("click");
    await flushPromises();

    expect(post).toHaveBeenCalledWith("/household/members/2/remove", { confirm_username: "bob", successor_member_id: 3 });
    expect(dialog().exists()).toBe(false);
  });

  it("keeps the dialog open with the server's message when the removal is refused", async () => {
    serve();
    const { fetchError } = await import("../fetch-error");
    post.mockRejectedValue(fetchError(422, { detail: "Ungültiger Nachfolger" }));
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="remove-member"]')).toHaveLength(2));
    await wrapper.findAll('[data-testid="remove-member"]')[0]!.trigger("click");
    await wrapper.find('[data-testid="remove-confirm"]').setValue("bob");
    await wrapper.find('[data-testid="remove-submit"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="remove-dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="remove-error"]').text()).toContain("Ungültiger Nachfolger");
  });

  it("lists removed members with a pill while the removal is completing", async () => {
    serve(() => [removal("completing"), { ...removal("done"), member_id: 5, username: "dora" }]);
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="removal-row"]')).toHaveLength(2));
    const rows = wrapper.findAll('[data-testid="removal-row"]');
    expect(rows[0]!.text()).toContain("bob");
    expect(rows[0]!.find('[data-testid="removal-completing"]').text()).toBe("wird abgeschlossen");
    expect(rows[1]!.find('[data-testid="removal-completing"]').exists()).toBe(false);
  });
});
