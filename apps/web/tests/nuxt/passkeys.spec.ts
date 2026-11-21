import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteLocationNormalized } from "vue-router";

import Passkeys from "~/components/settings/Passkeys.vue";
import Wiederherstellung from "~/components/settings/Wiederherstellung.vue";
import authMiddleware from "~/middleware/auth";
import EnrolPage from "~/pages/enrol.vue";
import SetupPage from "~/pages/setup/[token].vue";
import { confirmWithPasskey, withStepUp } from "~/utils/passkeys";
import { fetchError } from "../fetch-error";

/**
 * A fake transport (`raw`) behind the real step-up logic, so these specs
 * exercise the retry path exactly as `useApi` wires it.
 */
const { api, raw, navigate, startAuthentication, startRegistration } = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  raw: vi.fn(),
  navigate: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

mockNuxtImport("useApi", () => () => api);
mockNuxtImport("navigateTo", () => navigate);
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration }));

beforeAll(() => {
  const post = <T>(path: string, body?: unknown) => raw("POST", path, body) as Promise<T>;
  const guarded = <T>(run: () => Promise<T>) => withStepUp(run, () => confirmWithPasskey(post));
  Object.assign(api, {
    get: (path: string) => guarded(() => raw("GET", path)),
    post: (path: string, body?: unknown) => guarded(() => post(path, body)),
    patch: (path: string, body: unknown) => guarded(() => raw("PATCH", path, body)),
    put: (path: string, body: unknown) => guarded(() => raw("PUT", path, body)),
    del: (path: string) => guarded(() => raw("DELETE", path)),
    upload: vi.fn(),
  });
});

const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-000${i}`);
const GOOGLE = {
  id: 1,
  name: "Google Passwortmanager · 21.11.2026",
  provider: "Google Passwortmanager",
  synced: true,
  rp_id: "localhost",
  created_at: "2026-11-21T10:00:00Z",
  last_used_at: "2026-11-21T11:00:00Z",
  prf: false,
};
const HELLO = { ...GOOGLE, id: 2, name: "Büro-PC", provider: "Windows Hello", synced: false, last_used_at: null };

type Handler = (method: string, path: string, body?: unknown) => unknown;
function serve(handler: Handler) {
  raw.mockImplementation(async (method: string, path: string, body?: unknown) => handler(method, path, body));
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [raw, navigate, startAuthentication, startRegistration]) fn.mockReset();
  navigate.mockImplementation((to: string) => to);
});

describe("Passkeys (Konto)", () => {
  it("lists provider, synced / device-bound and address", async () => {
    serve((method, path) => (path === "/auth/passkeys" ? [GOOGLE, HELLO] : undefined));
    const wrapper = await mountSuspended(Passkeys);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="passkey-row"]')).toHaveLength(2));
    const [first, second] = wrapper.findAll('[data-testid="passkey-row"]');
    expect(first!.text()).toContain("Google Passwortmanager · synchronisiert · localhost");
    expect(second!.text()).toContain("Windows Hello · nur dieses Gerät · localhost");
    expect(wrapper.find('[data-testid="only-one-passkey"]').exists()).toBe(false);
  });

  it("warns with only one passkey and won't remove it", async () => {
    serve((method, path) => (path === "/auth/passkeys" ? [GOOGLE] : undefined));
    const wrapper = await mountSuspended(Passkeys);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="only-one-passkey"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="passkey-remove"]').attributes("disabled")).toBeDefined();
  });

  it("renames after a step-up: refused once, confirmed with a passkey, repeated", async () => {
    let confirmed = false;
    serve((method, path, body) => {
      if (method === "GET" && path === "/auth/passkeys") return [GOOGLE, HELLO];
      if (method === "PATCH") {
        if (!confirmed) throw fetchError(403, { detail: "step_up_required" });
        return { ...HELLO, name: (body as { name: string }).name };
      }
      if (path === "/auth/step-up/begin") return { ceremony: "s1", options: { challenge: "y" } };
      if (path === "/auth/step-up/finish") {
        confirmed = true;
        return undefined;
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    startAuthentication.mockResolvedValue({ id: "cred" });
    const wrapper = await mountSuspended(Passkeys);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="passkey-rename"]')).toHaveLength(2));
    await wrapper.findAll('[data-testid="passkey-rename"]')[1]!.trigger("click");
    await wrapper.find('[data-testid="passkey-name-input"]').setValue("Laptop");
    await wrapper.findAll('[data-testid="passkey-row"]')[1]!.find("form").trigger("submit");
    await flushPromises();
    const patches = raw.mock.calls.filter(([m]) => m === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual(["PATCH", "/auth/passkeys/2", { name: "Laptop" }]);
    expect(startAuthentication).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith("POST", "/auth/step-up/finish", { ceremony: "s1", response: { id: "cred" } });
    expect(wrapper.find('[data-testid="passkey-error"]').exists()).toBe(false);
  });

  it("a cancelled confirmation shows the German message and changes nothing", async () => {
    serve((method, path) => {
      if (method === "GET") return [GOOGLE, HELLO];
      if (method === "DELETE") throw fetchError(403, { detail: "step_up_required" });
      if (path === "/auth/step-up/begin") return { ceremony: "s1", options: {} };
      throw new Error(`unexpected ${method} ${path}`);
    });
    startAuthentication.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const wrapper = await mountSuspended(Passkeys);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="passkey-remove"]')).toHaveLength(2));
    await wrapper.findAll('[data-testid="passkey-remove"]')[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="passkey-error"]').text()).toBe("Bestätigung abgebrochen.");
    expect(raw.mock.calls.filter(([m]) => m === "DELETE")).toHaveLength(1);
  });

  it("adds a passkey (begin → create → finish)", async () => {
    serve((method, path) => {
      if (method === "GET" && path === "/auth/passkeys") return [GOOGLE];
      if (method === "GET" && path === "/auth/me") return { username: "bob" };
      if (path === "/auth/passkeys/register/begin") return { ceremony: "r1", options: { challenge: "z" } };
      if (path === "/auth/passkeys/register/finish") return { passkey: HELLO, recovery_codes: null };
      throw new Error(`unexpected ${method} ${path}`);
    });
    startRegistration.mockResolvedValue({ id: "new" });
    const wrapper = await mountSuspended(Passkeys);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="passkey-add"]').exists()).toBe(true));
    await wrapper.find('[data-testid="passkey-add"]').trigger("click");
    await flushPromises();
    expect(raw).toHaveBeenCalledWith("POST", "/auth/passkeys/register/finish", { ceremony: "r1", response: { id: "new" } });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="passkey-message"]').text()).toContain("hinzugefügt"));
  });

  it("explains that the authenticator already holds a passkey", async () => {
    serve((method, path) => {
      if (method === "GET") return [GOOGLE];
      if (path === "/auth/passkeys/register/begin") return { ceremony: "r1", options: {} };
      throw new Error(`unexpected ${method} ${path}`);
    });
    startRegistration.mockRejectedValue(Object.assign(new Error("x"), { name: "InvalidStateError" }));
    const wrapper = await mountSuspended(Passkeys);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="passkey-add"]').exists()).toBe(true));
    await wrapper.find('[data-testid="passkey-add"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="passkey-error"]').text()).toContain("schon einen Passkey");
  });
});

describe("Wiederherstellung (Konto)", () => {
  it("shows the remaining count and a new set once", async () => {
    serve((method, path) => {
      if (method === "GET" && path === "/auth/recovery-codes") return { remaining: 2 };
      if (method === "GET" && path === "/auth/me") return { username: "bob" };
      if (method === "POST" && path === "/auth/recovery-codes") return { codes: CODES };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const wrapper = await mountSuspended(Wiederherstellung);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="recovery-remaining"]').text()).toContain("2 von 10"));
    expect(wrapper.text()).toContain("Nur noch wenige Codes");
    await wrapper.find('[data-testid="recovery-regenerate"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="recovery-code"]')).toHaveLength(10);
    await wrapper.find('[data-testid="codes-continue"]').trigger("click");
    expect(wrapper.findAll('[data-testid="recovery-code"]')).toHaveLength(0);
  });
});

describe("enrolment page", () => {
  it("creates the first passkey, shows the codes once and continues on 'Weiter'", async () => {
    let enrolled = false;
    serve((method, path) => {
      if (method === "GET" && path === "/auth/me") return { username: "bob", enrolment_required: !enrolled };
      if (method === "GET" && path === "/auth/webauthn") return { origins: [window.location.origin] };
      if (path === "/auth/passkeys/register/begin") return { ceremony: "r1", options: { challenge: "z" } };
      if (path === "/auth/passkeys/register/finish") {
        enrolled = true;
        return { passkey: GOOGLE, recovery_codes: CODES };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    startRegistration.mockResolvedValue({ id: "new" });
    const wrapper = await mountSuspended(EnrolPage);
    await wrapper.find('[data-testid="enrol-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="recovery-code"]')).toHaveLength(10);
    expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toMatchObject({ enrolment_required: false });
    expect(navigate).not.toHaveBeenCalled();
    await wrapper.find('[data-testid="codes-continue"]').trigger("click");
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("explains a cancelled dialog and offers it again", async () => {
    serve((method, path) => {
      if (method === "GET" && path === "/auth/me") return { username: "bob", enrolment_required: true };
      if (method === "GET") return { origins: [window.location.origin] };
      if (path === "/auth/passkeys/register/begin") return { ceremony: "r1", options: {} };
      throw new Error(`unexpected ${method} ${path}`);
    });
    startRegistration.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const wrapper = await mountSuspended(EnrolPage);
    await wrapper.find('[data-testid="enrol-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="enrol-error"]').text()).toContain("abgebrochen");
    expect(wrapper.find('[data-testid="enrol-create"]').exists()).toBe(true);
  });
});

describe("setup page", () => {
  function serveSetup(check: () => unknown, finish: () => unknown = () => ({ username: "bob", recovery_codes: CODES })) {
    serve((method, path) => {
      if (method === "GET" && path === "/setup/tok1") return check();
      if (method === "GET" && path === "/auth/me") return { username: "bob", enrolment_required: false };
      if (method === "GET" && path === "/auth/webauthn") return { origins: [window.location.origin] };
      if (path === "/setup/tok1/register/begin") return { ceremony: "r1", options: {} };
      if (path === "/setup/tok1/register/finish") return finish();
      throw new Error(`unexpected ${method} ${path}`);
    });
  }

  it("enrols, shows new codes and offers to sign out other devices", async () => {
    serveSetup(() => ({ username: "bob", expires_at: "2026-11-21T10:30:00Z" }));
    startRegistration.mockResolvedValue({ id: "new" });
    const wrapper = await mountSuspended(SetupPage, { route: "/setup/tok1" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="setup-username"]').text()).toBe("bob"));
    await wrapper.find('[data-testid="setup-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="recovery-code"]')).toHaveLength(10);
    expect(wrapper.find('[data-testid="setup-other-devices"]').text()).toContain("Andere Geräte abmelden");
    await wrapper.find('[data-testid="codes-continue"]').trigger("click");
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("explains an invalid link", async () => {
    serveSetup(() => {
      throw fetchError(404, { detail: "Einrichtungslink ungültig oder abgelaufen" });
    });
    const wrapper = await mountSuspended(SetupPage, { route: "/setup/tok1" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="setup-invalid"]').exists()).toBe(true));
    expect(wrapper.text()).toContain("ungültig, abgelaufen oder wurde schon verwendet");
  });

  it("keeps the link usable after a cancelled dialog", async () => {
    serveSetup(() => ({ username: "bob", expires_at: "2026-11-21T10:30:00Z" }));
    startRegistration.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const wrapper = await mountSuspended(SetupPage, { route: "/setup/tok1" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="setup-create"]').exists()).toBe(true));
    await wrapper.find('[data-testid="setup-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="setup-error"]').text()).toContain("abgebrochen");
    expect(raw.mock.calls.some(([, path]) => path === "/setup/tok1/register/finish")).toBe(false);
  });
});

describe("auth middleware and enrolment", () => {
  it("sends a restricted session to /enrol from anywhere but /enrol", async () => {
    serve((method, path) => (path === "/auth/me" ? { username: "bob", enrolment_required: true } : undefined));
    expect(await authMiddleware({ path: "/library" } as RouteLocationNormalized, {} as RouteLocationNormalized)).toBe("/enrol");
    expect(await authMiddleware({ path: "/enrol" } as RouteLocationNormalized, {} as RouteLocationNormalized)).toBeUndefined();
  });
});
