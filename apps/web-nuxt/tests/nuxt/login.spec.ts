import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "~/pages/login.vue";
import { fetchError } from "../fetch-error";

const { post, navigate } = vi.hoisted(() => ({ post: vi.fn(), navigate: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get: vi.fn(), post, patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));
mockNuxtImport("navigateTo", () => navigate);

describe("login page", () => {
  beforeEach(() => {
    useNuxtApp().$queryClient.clear();
    post.mockReset();
    navigate.mockReset();
  });

  async function submit(username: string, password: string) {
    const wrapper = await mountSuspended(LoginPage);
    await wrapper.find('input[name="username"]').setValue(username);
    await wrapper.find('input[name="password"]').setValue(password);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    return wrapper;
  }

  it("posts the credentials to /api/auth/login", async () => {
    post.mockResolvedValue({ username: "admin" });
    await submit("admin", "hunter2");
    expect(post).toHaveBeenCalledWith("/auth/login", { username: "admin", password: "hunter2" });
  });

  it("seeds the me cache and navigates home on success", async () => {
    post.mockResolvedValue({ username: "admin" });
    await submit("admin", "hunter2");
    expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toEqual({ username: "admin" });
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("shows the German error and does not navigate on 401", async () => {
    post.mockRejectedValue(fetchError(401, { detail: "Invalid credentials" }));
    const wrapper = await submit("admin", "wrong");
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="login-error"]').text()).toContain("Ungültige Anmeldedaten"),
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
