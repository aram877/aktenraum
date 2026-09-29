import { mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

const { get, upload } = vi.hoisted(() => ({ get: vi.fn(), upload: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), upload }));

function mountTracker() {
  let tracker!: ReturnType<typeof useUploadTracker>;
  const wrapper = mount(
    defineComponent({
      setup() {
        tracker = useUploadTracker();
        return () => h("div");
      },
    }),
  );
  return { wrapper, tracker };
}

function file(name: string): File {
  return new File(["x"], name, { type: "application/pdf" });
}

function phases(tracker: ReturnType<typeof useUploadTracker>): Record<string, string> {
  return Object.fromEntries(tracker.files.value.map((f) => [f.name, f.phase]));
}

describe("useUploadTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset();
    upload.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends every file as multipart form data", async () => {
    upload.mockResolvedValue({ results: [] });
    const { tracker } = mountTracker();
    await tracker.send([file("a.pdf"), file("b.pdf")]);
    const [path, form] = upload.mock.calls[0] as [string, FormData];
    expect(path).toBe("/documents/upload");
    expect(form.getAll("files").map((f) => (f as File).name)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("follows each file from task to lifecycle tag, isolating a rejected one", async () => {
    upload.mockResolvedValue({
      results: [
        { filename: "a.pdf", status: "accepted", task_id: "t-a" },
        { filename: "b.pdf", status: "error", detail: "Dateityp nicht erlaubt" },
        { filename: "c.pdf", status: "accepted", task_id: "t-c" },
      ],
    });
    get.mockImplementation((path: string) => {
      if (path === "/documents/task/t-a") return Promise.resolve({ task_id: "t-a", status: "SUCCESS", doc_id: 1 });
      if (path === "/documents/task/t-c") return Promise.resolve({ task_id: "t-c", status: "SUCCESS", doc_id: 3 });
      if (path === "/documents/1/status") return Promise.resolve({ id: 1, lifecycle_tags: ["ai-pending"] });
      if (path === "/documents/3/status") return Promise.resolve({ id: 3, lifecycle_tags: ["ai-propagated"] });
      return Promise.reject(new Error(path));
    });
    const { tracker } = mountTracker();
    await tracker.send([file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    expect(phases(tracker)).toEqual({ "a.pdf": "consuming", "b.pdf": "error", "c.pdf": "consuming" });

    await vi.advanceTimersByTimeAsync(TASK_POLL_MS);
    expect(phases(tracker)).toEqual({ "a.pdf": "classifying", "b.pdf": "error", "c.pdf": "classifying" });

    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(phases(tracker)).toEqual({ "a.pdf": "inbox", "b.pdf": "error", "c.pdf": "library" });
    expect(tracker.files.value.find((f) => f.name === "b.pdf")?.detail).toBe("Dateityp nicht erlaubt");
  });

  it("marks every file failed when the upload request itself fails", async () => {
    upload.mockRejectedValue(new Error("Netzwerkfehler"));
    const { tracker } = mountTracker();
    await tracker.send([file("a.pdf")]);
    expect(tracker.files.value[0]).toMatchObject({ phase: "error", detail: "Netzwerkfehler" });
  });

  it("stops polling once the page is left", async () => {
    upload.mockResolvedValue({ results: [{ filename: "a.pdf", status: "accepted", task_id: "t-a" }] });
    get.mockResolvedValue({ task_id: "t-a", status: "PENDING" });
    const { wrapper, tracker } = mountTracker();
    await tracker.send([file("a.pdf")]);
    await vi.advanceTimersByTimeAsync(TASK_POLL_MS);
    expect(get).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 5);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
