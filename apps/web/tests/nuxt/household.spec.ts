import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Mitglieder from "~/components/settings/Mitglieder.vue";
import InvitePage from "~/pages/invite/[token].vue";
import SettingsPage from "~/pages/settings.vue";
import { fetchError } from "../fetch-error";

const { get, post, del, navigate, startRegistration } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  navigate: vi.fn(),
  startRegistration: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put: vi.fn(), upload: vi.fn(), del }));
mockNuxtImport("navigateTo", () => navigate);
vi.mock("@simplewebauthn/browser", () => ({ startRegistration, startAuthentication: vi.fn() }));

const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-000${i}`);

const MEMBERS = [
  { id: 1, username: "aram", role: "admin", joined_at: "2026-05-01T10:00:00Z" },
  { id: 2, username: "partner", role: "member", joined_at: "2026-11-19T10:00:00Z" },
];

function serve(me: { username: string; household_role: "admin" | "member" }, invites: unknown[] = []) {
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve(me);
    if (path === "/household/members") return Promise.resolve(MEMBERS);
    if (path === "/household/invites") return Promise.resolve(invites);
    if (path.startsWith("/settings/")) return new Promise(() => undefined);
    if (path.startsWith("/health/")) return new Promise(() => undefined);
    return new Promise(() => undefined);
  });
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, del, navigate, startRegistration]) fn.mockReset();
});

describe("settings page by role", () => {
  it("shows household sections and Mitglieder to the household admin", async () => {
    serve({ username: "aram", household_role: "admin" });
    const wrapper = await mountSuspended(SettingsPage, { route: "/settings" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="mitglieder"]').exists()).toBe(true));
    expect(wrapper.text()).toContain("Modell für Klassifizierung");
    expect(wrapper.text()).toContain("Konto");
  });

  it("shows a plain member only their account", async () => {
    serve({ username: "partner", household_role: "member" });
    const wrapper = await mountSuspended(SettingsPage, { route: "/settings" });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Konto"));
    expect(wrapper.find('[data-testid="mitglieder"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Modell für Klassifizierung");
    expect(get).not.toHaveBeenCalledWith("/household/members");
  });
});

describe("Mitglieder", () => {
  it("lists members and shows a fresh invite link once", async () => {
    serve({ username: "aram", household_role: "admin" });
    post.mockResolvedValue({ id: 7, token: "abc_DEF-123", created_at: "2026-11-19T10:00:00Z", expires_at: "2026-11-26T10:00:00Z" });
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(2));
    expect(wrapper.text()).toContain("partner");
    expect(wrapper.text()).toContain("Mitglied");

    await wrapper.find('[data-testid="create-invite"]').trigger("click");
    await flushPromises();

    expect(post).toHaveBeenCalledWith("/household/invites");
    const url = wrapper.find('[data-testid="invite-url"]').element as HTMLInputElement;
    expect(url.value).toBe(`${window.location.origin}/invite/abc_DEF-123`);
    expect(wrapper.text()).toContain("26.11.2026");
  });

  it("revokes a pending invite", async () => {
    serve({ username: "aram", household_role: "admin" }, [
      { id: 3, created_at: "2026-11-19T10:00:00Z", expires_at: "2026-11-26T10:00:00Z" },
    ]);
    del.mockResolvedValue(undefined);
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="invite-row"]').exists()).toBe(true));
    await wrapper.find('[data-testid="revoke-invite"]').trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/household/invites/3");
  });
});

describe("Mitglieder: setup links", () => {
  it("creates a single-use setup link for a member and shows it once", async () => {
    serve({ username: "aram", household_role: "admin" });
    post.mockResolvedValue({ id: 4, token: "setup_TOK", expires_at: "2026-11-21T10:30:00Z" });
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(2));
    // Every member row has it — the admin's own too.
    expect(wrapper.findAll('[data-testid="create-setup-link"]')).toHaveLength(2);
    await wrapper.findAll('[data-testid="create-setup-link"]')[1]!.trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/household/members/2/setup-link");
    const url = wrapper.find('[data-testid="setup-link-url"]').element as HTMLInputElement;
    expect(url.value).toBe(`${window.location.origin}/setup/setup_TOK`);
    expect(wrapper.find('[data-testid="setup-link"]').text()).toContain("partner");
  });

  it("explains a cancelled confirmation", async () => {
    serve({ username: "aram", household_role: "admin" });
    post.mockRejectedValue(Object.assign(new Error("x"), { name: "PasskeyCancelledError", message: "Bestätigung abgebrochen." }));
    const wrapper = await mountSuspended(Mitglieder);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="create-setup-link"]')).toHaveLength(2));
    await wrapper.findAll('[data-testid="create-setup-link"]')[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="setup-link"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="setup-link-error"]').exists()).toBe(true);
  });
});

describe("invite page", () => {
  function servePublic(check: () => Promise<unknown>) {
    get.mockImplementation((path: string) => {
      if (path === "/auth/me") return Promise.reject(fetchError(401, { detail: "Not authenticated" }));
      if (path.startsWith("/invites/")) return check();
      return new Promise(() => undefined);
    });
  }

  it("joins with a username and a passkey, shows the recovery codes once, then goes home", async () => {
    servePublic(() => Promise.resolve({ expires_at: "2026-11-26T10:00:00Z" }));
    post.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/begin")
          ? { ceremony: "c1", options: { challenge: "x" } }
          : { username: "partner", recovery_codes: CODES },
      ),
    );
    startRegistration.mockResolvedValue({ id: "new-cred" });
    const wrapper = await mountSuspended(InvitePage, { route: "/invite/tok123" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="invite-form"]').exists()).toBe(true));
    expect(wrapper.find('input[name="password"]').exists()).toBe(false);

    await wrapper.find('input[name="username"]').setValue("partner");
    await wrapper.find('[data-testid="invite-form"]').trigger("submit");
    await flushPromises();

    expect(post).toHaveBeenNthCalledWith(1, "/invites/tok123/register/begin", { username: "partner" });
    expect(post).toHaveBeenNthCalledWith(2, "/invites/tok123/register/finish", { ceremony: "c1", response: { id: "new-cred" } });
    expect(wrapper.findAll('[data-testid="recovery-code"]')).toHaveLength(10);
    expect(useNuxtApp().$queryClient.getQueryData(["me"])).toMatchObject({ username: "partner", household_role: "member" });
    expect(navigate).not.toHaveBeenCalled();
    await wrapper.find('[data-testid="codes-continue"]').trigger("click");
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("a cancelled passkey dialog keeps the form and says so", async () => {
    servePublic(() => Promise.resolve({ expires_at: "2026-11-26T10:00:00Z" }));
    post.mockResolvedValue({ ceremony: "c1", options: {} });
    startRegistration.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const wrapper = await mountSuspended(InvitePage, { route: "/invite/tok123" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="invite-form"]').exists()).toBe(true));
    await wrapper.find('input[name="username"]').setValue("partner");
    await wrapper.find('[data-testid="invite-form"]').trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="redeem-error"]').text()).toContain("abgebrochen");
    expect(wrapper.find('[data-testid="invite-form"]').exists()).toBe(true);
    expect(post).toHaveBeenCalledTimes(1); // begin only
  });

  it("explains an invalid link", async () => {
    servePublic(() => Promise.reject(fetchError(404, { detail: "Einladung ungültig oder abgelaufen" })));
    const wrapper = await mountSuspended(InvitePage, { route: "/invite/old" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="invite-invalid"]').exists()).toBe(true));
    expect(wrapper.text()).toContain("ungültig, abgelaufen oder wurde schon verwendet");
    expect(wrapper.find('[data-testid="invite-form"]').exists()).toBe(false);
  });

  it("says when the username is taken", async () => {
    servePublic(() => Promise.resolve({ expires_at: "2026-11-26T10:00:00Z" }));
    post.mockRejectedValue(fetchError(409, { detail: "Benutzername bereits vergeben" }));
    const wrapper = await mountSuspended(InvitePage, { route: "/invite/tok123" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="invite-form"]').exists()).toBe(true));
    await wrapper.find('input[name="username"]').setValue("aram");
    await wrapper.find('[data-testid="invite-form"]').trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="redeem-error"]').text()).toContain("bereits vergeben");
    expect(startRegistration).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith("/");
  });
});
