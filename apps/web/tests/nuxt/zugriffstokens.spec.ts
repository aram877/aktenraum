import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import Zugriffstokens from "~/components/settings/Zugriffstokens.vue";
import { confirmWithPasskey, withStepUp } from "~/utils/passkeys";
import { fetchError } from "../fetch-error";

/**
 * A fake transport (`raw`) behind the real step-up logic, so the create flow
 * exercises the retry path exactly as `useApi` wires it.
 */
const { api, raw, startAuthentication } = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  raw: vi.fn(),
  startAuthentication: vi.fn(),
}));

mockNuxtImport("useApi", () => () => api);
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration: vi.fn() }));

beforeAll(() => {
  const post = <T>(path: string, body?: unknown) => raw("POST", path, body) as Promise<T>;
  const guarded = <T>(run: () => Promise<T>) => withStepUp(run, () => confirmWithPasskey(post));
  Object.assign(api, {
    get: (path: string) => guarded(() => raw("GET", path)),
    post: (path: string, body?: unknown) => guarded(() => post(path, body)),
    patch: vi.fn(),
    put: vi.fn(),
    del: (path: string) => guarded(() => raw("DELETE", path)),
    upload: vi.fn(),
  });
});

const SCANNER = {
  id: 1,
  name: "Scanner",
  scopes: ["upload"],
  display_prefix: "akt_pat_AbCd",
  created_at: "2026-11-20T08:00:00Z",
  expires_at: "2027-02-18T08:00:00Z",
  last_used_at: "2026-11-21T09:30:00Z",
  last_used_ip: "192.168.1.20",
  revoked_at: null,
  state: "active",
};
const OLD = {
  ...SCANNER,
  id: 2,
  name: "Alter Export",
  scopes: ["documents:read"],
  display_prefix: "akt_pat_WxYz",
  expires_at: "2026-11-01T08:00:00Z",
  last_used_at: null,
  last_used_ip: null,
  state: "expired",
};
const GONE = { ...SCANNER, id: 3, name: "Geleakt", display_prefix: "akt_pat_Qq12", revoked_at: "2026-11-19T10:00:00Z", state: "revoked" };
const VALUE = `akt_pat_${"Z".repeat(43)}`;

type Handler = (method: string, path: string, body?: unknown) => unknown;
function serve(handler: Handler) {
  raw.mockImplementation(async (method: string, path: string, body?: unknown) => handler(method, path, body));
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  raw.mockReset();
  startAuthentication.mockReset();
});

async function mounted(rows = 1) {
  const wrapper = await mountSuspended(Zugriffstokens);
  await vi.waitFor(() => expect(wrapper.findAll('[data-testid="token-row"]')).toHaveLength(rows));
  return wrapper;
}

describe("Zugriffstokens", () => {
  it("lists tokens with scopes, last use and state; only active ones can be revoked", async () => {
    serve((method, path) => {
      if (method === "GET" && path === "/auth/tokens") return [SCANNER, OLD, GONE];
      throw new Error(`unexpected ${method} ${path}`);
    });
    const wrapper = await mounted(3);
    const rows = wrapper.findAll('[data-testid="token-row"]');
    expect(rows[0]!.text()).toContain("Scanner");
    expect(rows[0]!.text()).toContain("akt_pat_AbCd…");
    expect(rows[0]!.text()).toContain("Hochladen");
    expect(rows[0]!.find('[data-testid="token-usage"]').text()).toContain("von 192.168.1.20");
    expect(rows[0]!.find('[data-testid="token-state"]').text()).toBe("aktiv");
    expect(rows[1]!.find('[data-testid="token-state"]').text()).toBe("abgelaufen");
    expect(rows[1]!.find('[data-testid="token-usage"]').text()).toContain("nie benutzt");
    expect(rows[1]!.text()).toContain("Dokumente lesen");
    expect(rows[2]!.find('[data-testid="token-state"]').text()).toBe("widerrufen");
    expect(rows.map((r) => r.find('[data-testid="token-revoke"]').exists())).toEqual([true, false, false]);
  });

  it("shows an empty state", async () => {
    serve(() => []);
    const wrapper = await mountSuspended(Zugriffstokens);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tokens-empty"]').exists()).toBe(true));
  });

  it("creates a token after the passkey confirmation, shows the value once and forgets it on close", async () => {
    let confirmed = false;
    let created = false;
    serve((method, path, body) => {
      if (method === "GET" && path === "/auth/tokens") return created ? [{ ...SCANNER, id: 4, name: "Backup" }, SCANNER] : [SCANNER];
      if (method === "POST" && path === "/auth/tokens") {
        if (!confirmed) throw fetchError(403, { detail: "step_up_required" });
        created = true;
        return { token: { ...SCANNER, id: 4, name: (body as { name: string }).name }, value: VALUE };
      }
      if (path === "/auth/step-up/begin") return { ceremony: "s1", options: { challenge: "y" } };
      if (path === "/auth/step-up/finish") {
        confirmed = true;
        return undefined;
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    startAuthentication.mockResolvedValue({ id: "cred" });
    const wrapper = await mounted(1);

    await wrapper.find('[data-testid="token-new"]').trigger("click");
    expect(wrapper.find('[data-testid="token-submit"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="token-name"]').setValue("  Backup ");
    await wrapper.find('[data-testid="token-scope-documents:read"]').setValue(true);
    await wrapper.find('[data-testid="token-scope-upload"]').setValue(true);
    await wrapper.find('[data-testid="token-expiry"]').setValue("custom");
    await wrapper.find('[data-testid="token-custom-days"]').setValue("400");
    expect(wrapper.find('[data-testid="token-submit"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="token-custom-days"]').setValue("120");
    await wrapper.find('[data-testid="token-dialog"]').trigger("submit");
    await flushPromises();

    const posts = raw.mock.calls.filter(([m, p]) => m === "POST" && p === "/auth/tokens");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(["POST", "/auth/tokens", { name: "Backup", scopes: ["documents:read", "upload"], expires_in_days: 120 }]);
    expect(startAuthentication).toHaveBeenCalledTimes(1);

    expect(wrapper.find('[data-testid="token-dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="token-value"]').text()).toBe(VALUE);
    expect(wrapper.find('[data-testid="token-created"]').text()).toContain("Wird nur jetzt angezeigt");
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="token-row"]')).toHaveLength(2));

    await wrapper.find('[data-testid="token-created-close"]').trigger("click");
    expect(wrapper.find('[data-testid="token-created"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(VALUE);
  });

  it("copies the value to the clipboard", async () => {
    serve((method, path) => {
      if (method === "GET") return [];
      if (method === "POST" && path === "/auth/tokens") return { token: SCANNER, value: VALUE };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = await mountSuspended(Zugriffstokens);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tokens-empty"]').exists()).toBe(true));
    await wrapper.find('[data-testid="token-new"]').trigger("click");
    await wrapper.find('[data-testid="token-name"]').setValue("Scanner");
    await wrapper.find('[data-testid="token-scope-upload"]').setValue(true);
    await wrapper.find('[data-testid="token-dialog"]').trigger("submit");
    await flushPromises();
    await wrapper.find('[data-testid="token-copy"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(VALUE);
    expect(wrapper.find('[data-testid="token-copy"]').text()).toBe("Kopiert");
  });

  it("a cancelled passkey confirmation creates nothing and says so", async () => {
    serve((method, path) => {
      if (method === "GET") return [SCANNER];
      if (method === "POST" && path === "/auth/tokens") throw fetchError(403, { detail: "step_up_required" });
      if (path === "/auth/step-up/begin") return { ceremony: "s1", options: {} };
      throw new Error(`unexpected ${method} ${path}`);
    });
    startAuthentication.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const wrapper = await mounted(1);
    await wrapper.find('[data-testid="token-new"]').trigger("click");
    await wrapper.find('[data-testid="token-name"]').setValue("Scanner");
    await wrapper.find('[data-testid="token-scope-upload"]').setValue(true);
    await wrapper.find('[data-testid="token-dialog"]').trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="token-create-error"]').text()).toBe("Bestätigung abgebrochen.");
    expect(wrapper.find('[data-testid="token-created"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="token-dialog"]').exists()).toBe(true);
  });

  it("revokes with a two-click confirm and refreshes the list", async () => {
    let revoked = false;
    serve((method, path) => {
      if (method === "GET" && path === "/auth/tokens") return revoked ? [{ ...SCANNER, state: "revoked", revoked_at: "2026-11-22T10:00:00Z" }] : [SCANNER];
      if (method === "DELETE" && path === "/auth/tokens/1") {
        revoked = true;
        return undefined;
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const wrapper = await mounted(1);
    await wrapper.find('[data-testid="token-revoke"]').trigger("click");
    expect(raw.mock.calls.filter(([m]) => m === "DELETE")).toHaveLength(0);
    expect(wrapper.find('[data-testid="token-revoke"]').text()).toBe("Wirklich widerrufen?");
    await wrapper.find('[data-testid="token-revoke"]').trigger("click");
    await flushPromises();
    expect(raw).toHaveBeenCalledWith("DELETE", "/auth/tokens/1");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="token-state"]').text()).toBe("widerrufen"));
    expect(wrapper.find('[data-testid="token-revoke"]').exists()).toBe(false);
  });
});
