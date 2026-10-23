import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActivityPage from "~/pages/activity.vue";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));

const SUMMARY = { new: 1, duplicate: 1, failed: 1, running: 0, by_source: { email: 2, upload: 0, folder: 1 } };

function payload(items: unknown[], extra: Record<string, unknown> = {}) {
  return { days: 7, items, mails: [], summary: SUMMARY, truncated: false, ...extra };
}

const ITEMS = [
  {
    task_id: "t-new",
    file_name: "template.pdf",
    created: "2026-10-23T06:22:39Z",
    done: null,
    source: "email",
    outcome: "new",
    document: { id: 269, title: "Rechnung Oktober", lifecycle_tags: ["ai-propagated"], missing: false },
    duplicate_of: null,
    message: null,
  },
  {
    task_id: "t-dup",
    file_name: "LOBN_202603.pdf",
    created: "2026-10-23T06:22:39Z",
    done: null,
    source: "folder",
    outcome: "duplicate",
    document: null,
    duplicate_of: { id: 262, title: "Gehaltsabrechnung März 2026", lifecycle_tags: [], missing: false },
    message: null,
  },
  {
    task_id: "t-bad",
    file_name: "broken.pdf",
    created: "2026-10-23T06:22:39Z",
    done: null,
    source: "email",
    outcome: "failed",
    document: null,
    duplicate_of: null,
    message: "PDF is damaged",
  },
];

function serve(activity: unknown): void {
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "admin" });
    if (path.startsWith("/ingest/activity")) return Promise.resolve(activity);
    return new Promise(() => undefined);
  });
}

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  get.mockReset();
  serve(payload(ITEMS));
});

describe("activity page", () => {
  it("renders summary, outcomes and links", async () => {
    const wrapper = await mountSuspended(ActivityPage, { route: "/activity" });
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="activity-item"]')).toHaveLength(3));
    expect(get).toHaveBeenCalledWith("/ingest/activity?days=7");
    expect(wrapper.find('[data-testid="activity-summary"]').text()).toContain("1 neu");

    const dup = wrapper.find('[data-testid="duplicate-link"]');
    expect(dup.text()).toBe("#262 · Gehaltsabrechnung März 2026");
    expect(dup.attributes("href")).toBe("/library/262");
    expect(wrapper.text()).toContain("Rechnung Oktober");
    expect(wrapper.text()).toContain("PDF is damaged");
    expect(wrapper.find('[data-testid="activity-live"]').exists()).toBe(false);
  });

  it("filters rows by outcome", async () => {
    const wrapper = await mountSuspended(ActivityPage, { route: "/activity" });
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="activity-item"]')).toHaveLength(3));
    await wrapper.find('[data-testid="outcome-failed"]').trigger("click");
    expect(wrapper.findAll('[data-testid="activity-item"]')).toHaveLength(1);
  });

  it("reads the range from the URL", async () => {
    const wrapper = await mountSuspended(ActivityPage, { route: "/activity?days=30" });
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="activity-item"]')).toHaveLength(3));
    expect(get).toHaveBeenCalledWith("/ingest/activity?days=30");
  });

  it("shows the empty state", async () => {
    serve(payload([]));
    const wrapper = await mountSuspended(ActivityPage, { route: "/activity" });
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="activity-empty"]').text()).toBe("Keine Importe im gewählten Zeitraum."),
    );
  });

  it("explains a FAILED mail and shows the error summary", async () => {
    serve(
      payload(ITEMS, {
        mails: [
          {
            id: 9,
            subject: "Documents uandi",
            received: "2026-10-23T06:20:12Z",
            processed: "2026-10-23T06:24:17Z",
            status: "FAILED",
            error_summary: "ConsumerError: It is a duplicate of X (#39).",
          },
        ],
      }),
    );
    const wrapper = await mountSuspended(ActivityPage, { route: "/activity" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="activity-mail"]').exists()).toBe(true));
    const mail = wrapper.find('[data-testid="activity-mail"]').text();
    expect(mail).toContain("Documents uandi");
    expect(mail).toContain("Mit Fehlern");
    expect(mail).toContain("It is a duplicate of X (#39).");
  });

  it("polls while a new document is still being processed", async () => {
    const running = [{ ...ITEMS[0], document: { id: 269, title: "x", lifecycle_tags: [], missing: false } }];
    serve(payload(running));
    const wrapper = await mountSuspended(ActivityPage, { route: "/activity" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="activity-live"]').exists()).toBe(true));
  });
});
