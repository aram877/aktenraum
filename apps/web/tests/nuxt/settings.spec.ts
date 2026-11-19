import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AutoApprove from "~/components/settings/AutoApprove.vue";
import Backup from "~/components/settings/Backup.vue";
import Konto from "~/components/settings/Konto.vue";
import ModelPicker from "~/components/settings/ModelPicker.vue";
import { fetchError } from "../fetch-error";

const { get, post, put, navigate } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  navigate: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch: vi.fn(), put, upload: vi.fn() }));
mockNuxtImport("navigateTo", () => navigate);

const RULES = {
  rules: [
    { document_type: "Rechnung", enabled: false, min_confidence: 0.9, updated_at: null, updated_by: null },
    { document_type: "Beleg", enabled: true, min_confidence: 0.6, updated_at: null, updated_by: null },
  ],
};

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, put, navigate]) fn.mockReset();
});

describe("AutoApprove", () => {
  it("sends every rule with the edited value and confirms the save", async () => {
    get.mockResolvedValue(RULES);
    put.mockResolvedValue(RULES);
    const wrapper = await mountSuspended(AutoApprove);
    await vi.waitFor(() => expect(wrapper.text()).toContain("Rechnung"));

    const save = wrapper.find('[data-testid="auto-approve-save"]');
    expect(save.attributes("disabled")).toBeDefined();

    await wrapper.find('[data-testid="enabled-Rechnung"]').setValue(true);
    expect(save.attributes("disabled")).toBeUndefined();
    await save.trigger("click");
    await flushPromises();

    expect(put).toHaveBeenCalledWith("/settings/auto-approve", {
      rules: [
        { document_type: "Rechnung", enabled: true, min_confidence: 0.9 },
        { document_type: "Beleg", enabled: true, min_confidence: 0.6 },
      ],
    });
    expect(wrapper.find('[data-testid="auto-approve-saved"]').exists()).toBe(true);
  });

  it("flags a threshold below 0.70", async () => {
    get.mockResolvedValue(RULES);
    const wrapper = await mountSuspended(AutoApprove);
    await vi.waitFor(() => expect(wrapper.text()).toContain("Achtung: niedriger Schwellwert"));
  });
});

describe("Konto", () => {
  async function fill(current: string, next: string, confirm: string) {
    const wrapper = await mountSuspended(Konto);
    await wrapper.find('input[name="current"]').setValue(current);
    await wrapper.find('input[name="next"]').setValue(next);
    await wrapper.find('input[name="confirm"]').setValue(confirm);
    return wrapper;
  }

  it("keeps the submit disabled until the confirmation matches", async () => {
    const wrapper = await fill("old-password", "new-password", "new-passwort");
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Passwörter stimmen nicht überein.");
  });

  it("shows the mapped German error on a wrong current password", async () => {
    post.mockRejectedValue(fetchError(401));
    const wrapper = await fill("wrong", "new-password", "new-password");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="konto-error"]').text()).toBe(
      "Aktuelles Passwort ist nicht korrekt.",
    );
  });

  it("clears the session and sends the user to the login after success", async () => {
    vi.useFakeTimers();
    post.mockResolvedValue(undefined);
    useNuxtApp().$queryClient.setQueryData(ME_KEY, { username: "admin" });
    const wrapper = await fill("old-password", "new-password", "new-password");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/auth/change-password", {
      current_password: "old-password",
      new_password: "new-password",
    });
    expect(useNuxtApp().$queryClient.getQueryData(ME_KEY)).toBeNull();
    expect(wrapper.find('[data-testid="konto-success"]').exists()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(navigate).toHaveBeenCalledWith("/login");
    vi.useRealTimers();
  });
});

describe("ModelPicker", () => {
  it("falls back to a manual input when no live model list is available", async () => {
    const wrapper = await mountSuspended(ModelPicker, {
      props: { title: "T", description: "D", fieldName: "m", activeModel: "qwen" },
    });
    expect(wrapper.find("select").exists()).toBe(false);
    expect((wrapper.find("input").element as HTMLInputElement).value).toBe("qwen");
    await wrapper.find("input").setValue("  llama  ");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("pick")).toEqual([["llama"]]);
  });

  it("keeps an active model that is missing from the live list selectable", async () => {
    const wrapper = await mountSuspended(ModelPicker, {
      props: { title: "T", description: "D", fieldName: "m", activeModel: "old", availableModels: ["a", "b"] },
    });
    expect(wrapper.findAll("option").map((o) => o.text())).toEqual(["old", "a", "b"]);
  });
});

describe("Backup section", () => {
  it("shows the last complete backup and stays green when fresh", async () => {
    get.mockResolvedValue({
      state: "ok",
      last_backup_at: "2026-11-19T10:31:49Z",
      age_hours: 2,
      max_age_hours: 36,
      checked_at: "2026-11-19T12:00:00Z",
      last_run_at: "2026-11-19T10:31:50Z",
      last_run_exit: 0,
      detail: "backups fresh",
    });
    const wrapper = await mountSuspended(Backup);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="backup-summary"]').text()).toContain("vor 2 Stunden"),
    );
    expect(get).toHaveBeenCalledWith("/health/backup");
    expect(wrapper.text()).not.toContain("docker compose logs backup");
  });

  it("points at the logs when backups are stale", async () => {
    get.mockResolvedValue({
      state: "stale",
      last_backup_at: "2026-10-16T08:14:12Z",
      age_hours: 817,
      max_age_hours: 36,
      checked_at: "2026-11-19T10:00:00Z",
      last_run_at: null,
      last_run_exit: null,
      detail: "latest filesystem snapshot is 817h old (limit 36h)",
    });
    const wrapper = await mountSuspended(Backup);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="backup-summary"]').text()).toContain("vor 34 Tagen"),
    );
    expect(wrapper.text()).toContain("docker compose logs backup");
    expect(wrapper.text()).toContain("817h old");
  });

  it("renders the API error", async () => {
    get.mockRejectedValue(fetchError(502, { detail: "kaputt" }));
    const wrapper = await mountSuspended(Backup);
    // The global `retry: 1` re-runs the query once (~1 s back-off) before it errors.
    await vi.waitFor(
      () => expect(wrapper.find('[data-testid="backup-error"]').text()).toBe("kaputt"),
      { timeout: 3000 },
    );
  });
});
