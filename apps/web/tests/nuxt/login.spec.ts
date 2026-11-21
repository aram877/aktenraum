import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "~/pages/login.vue";
import { fetchError } from "../fetch-error";

const { get, post, navigate, startAuthentication } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  navigate: vi.fn(),
  startAuthentication: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put: vi.fn(), upload: vi.fn(), del: vi.fn() }));
mockNuxtImport("navigateTo", () => navigate);
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration: vi.fn() }));

const ORIGINS = { origins: ["http://localhost:8080", "http://localhost:4300"] };

describe("login page", () => {
  beforeEach(() => {
    useNuxtApp().$queryClient.clear();
    for (const fn of [get, post, navigate, startAuthentication]) fn.mockReset();
  });

  function serve(me: unknown = null) {
    get.mockImplementation((path: string) => {
      if (path === "/auth/webauthn") return Promise.resolve(ORIGINS);
      if (path === "/auth/me") return me ? Promise.resolve(me) : Promise.reject(fetchError(401));
      return new Promise(() => undefined);
    });
  }

  it("signs in with a passkey via begin/finish and seeds the me cache", async () => {
    const user = { username: "admin", household_role: "admin", enrolment_required: false, auth_method: "passkey" };
    serve(user);
    post.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/begin") ? { ceremony: "c1", options: { challenge: "x" } } : { username: "admin" }),
    );
    startAuthentication.mockResolvedValue({ id: "cred" });
    const wrapper = await mountSuspended(LoginPage);
    await wrapper.find('[data-testid="passkey-login"]').trigger("click");
    await flushPromises();
    expect(post.mock.calls[0]?.[0]).toBe("/auth/passkeys/login/begin");
    expect(post).toHaveBeenNthCalledWith(2, "/auth/passkeys/login/finish", { ceremony: "c1", response: { id: "cred" } });
    await vi.waitFor(() => expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toEqual(user));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("explains a cancelled passkey dialog and stays", async () => {
    serve();
    post.mockResolvedValue({ ceremony: "c1", options: {} });
    startAuthentication.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const wrapper = await mountSuspended(LoginPage);
    await wrapper.find('[data-testid="passkey-login"]').trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="passkey-error"]').text()).toContain("abgebrochen"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("first sign-in with a password goes to enrolment", async () => {
    serve();
    post.mockResolvedValue({ username: "admin", enrolment_required: true });
    const wrapper = await mountSuspended(LoginPage);
    await wrapper.find('[data-testid="mode-password"]').trigger("click");
    await wrapper.find('input[name="username"]').setValue("admin");
    await wrapper.find('input[name="password"]').setValue("hunter2");
    await wrapper.find('[data-testid="password-form"]').trigger("submit");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/auth/login", { username: "admin", password: "hunter2" });
    expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toMatchObject({ enrolment_required: true });
    expect(navigate).toHaveBeenCalledWith("/enrol");
  });

  it("shows the German error on a wrong password", async () => {
    serve();
    post.mockRejectedValue(fetchError(401, { detail: "Invalid credentials" }));
    const wrapper = await mountSuspended(LoginPage);
    await wrapper.find('[data-testid="mode-password"]').trigger("click");
    await wrapper.find('input[name="username"]').setValue("admin");
    await wrapper.find('input[name="password"]').setValue("wrong");
    await wrapper.find('[data-testid="password-form"]').trigger("submit");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="login-error"]').text()).toContain("Ungültige Anmeldedaten"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a recovery code leads to enrolment; a wrong one says so", async () => {
    serve();
    post.mockRejectedValueOnce(fetchError(401)).mockResolvedValueOnce({ username: "bob", enrolment_required: true });
    const wrapper = await mountSuspended(LoginPage);
    await wrapper.find('[data-testid="mode-recovery"]').trigger("click");
    await wrapper.find('input[name="username"]').setValue("bob");
    await wrapper.find('input[name="code"]').setValue("aaaa-bbbb-cccc-dddd");
    await wrapper.find('[data-testid="recovery-form"]').trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="recovery-error"]').text()).toContain("Wiederherstellungscode falsch");
    await wrapper.find('[data-testid="recovery-form"]').trigger("submit");
    await flushPromises();
    expect(post).toHaveBeenLastCalledWith("/auth/recovery", { username: "bob", code: "aaaa-bbbb-cccc-dddd" });
    expect(navigate).toHaveBeenCalledWith("/enrol");
  });

  it("shows the address hint on an origin without passkeys", async () => {
    serve();
    get.mockImplementation((path: string) =>
      path === "/auth/webauthn" ? Promise.resolve({ origins: ["https://box.tail1234.ts.net"] }) : Promise.reject(fetchError(401)),
    );
    const wrapper = await mountSuspended(LoginPage);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="address-hint"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="address-hint"]').text()).toContain("https://box.tail1234.ts.net");
  });

  it("shows no hint on a configured origin", async () => {
    serve();
    get.mockImplementation((path: string) =>
      path === "/auth/webauthn" ? Promise.resolve({ origins: [window.location.origin] }) : Promise.reject(fetchError(401)),
    );
    const wrapper = await mountSuspended(LoginPage);
    await flushPromises();
    expect(wrapper.find('[data-testid="address-hint"]').exists()).toBe(false);
  });
});
