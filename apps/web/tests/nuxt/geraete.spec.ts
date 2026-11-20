import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Geraete from "~/components/settings/Geraete.vue";

const { get, post, del, navigate } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  navigate: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, del, patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));
mockNuxtImport("navigateTo", () => navigate);

const LAPTOP = {
  id: 7,
  created_at: "2026-11-20T08:00:00Z",
  last_seen_at: "2026-11-20T21:00:00Z",
  auth_method: "password",
  ip: "203.0.113.7",
  user_agent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  current: true,
};
const PHONE = {
  id: 9,
  created_at: "2026-11-18T08:00:00Z",
  last_seen_at: "2026-11-19T21:00:00Z",
  auth_method: "password",
  ip: "198.51.100.23",
  user_agent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  current: false,
};

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, del, navigate]) fn.mockReset();
});

async function mounted() {
  const wrapper = await mountSuspended(Geraete);
  await vi.waitFor(() => expect(wrapper.findAll('[data-testid="session-row"]').length).toBeGreaterThan(0));
  return wrapper;
}

describe("Geräte", () => {
  it("lists the sessions with device, address and the current marker", async () => {
    get.mockResolvedValue([LAPTOP, PHONE]);
    const wrapper = await mounted();
    expect(get).toHaveBeenCalledWith("/auth/sessions");
    const rows = wrapper.findAll('[data-testid="session-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("Chrome · Windows");
    expect(rows[0]!.text()).toContain("203.0.113.7");
    expect(rows[0]!.find('[data-testid="session-current"]').text()).toBe("dieses Gerät");
    expect(rows[1]!.text()).toContain("Safari · iOS");
    expect(rows[1]!.find('[data-testid="session-current"]').exists()).toBe(false);
  });

  it("signs out another device and refreshes the list", async () => {
    get.mockResolvedValueOnce([LAPTOP, PHONE]).mockResolvedValue([LAPTOP]);
    del.mockResolvedValue(undefined);
    useNuxtApp().$queryClient.setQueryData(ME_KEY, { username: "bob" });
    const wrapper = await mounted();
    await wrapper.findAll('[data-testid="session-revoke"]')[1]!.trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/auth/sessions/9");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="session-row"]')).toHaveLength(1));
    expect(get).toHaveBeenCalledTimes(2);
    expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toEqual({ username: "bob" });
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="session-revoke-others"]').exists()).toBe(false);
  });

  it("signs out all other devices with one POST and refreshes the list", async () => {
    get.mockResolvedValueOnce([LAPTOP, PHONE]).mockResolvedValue([LAPTOP]);
    post.mockResolvedValue({ revoked: 1 });
    const wrapper = await mounted();
    await wrapper.find('[data-testid="session-revoke-others"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/auth/sessions/revoke-others");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="session-row"]')).toHaveLength(1));
  });

  it("signing out this device logs out", async () => {
    get.mockResolvedValue([LAPTOP, PHONE]);
    del.mockResolvedValue(undefined);
    useNuxtApp().$queryClient.setQueryData(ME_KEY, { username: "bob" });
    const wrapper = await mounted();
    await wrapper.findAll('[data-testid="session-revoke"]')[0]!.trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/auth/sessions/7");
    expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/login");
  });
});
