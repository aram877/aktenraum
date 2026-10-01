import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LibraryDetailPage from "~/pages/library/[id].vue";

const { get, post, patch, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

mockNuxtImport("useApi", () => () => ({ get, post, patch, put: vi.fn(), upload: vi.fn(), del }));

let current: Record<string, unknown>;

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    title: "Stromrechnung",
    original_file_name: null,
    created: null,
    added: null,
    ai_correspondent: "Stadtwerke",
    ai_document_type: "Rechnung",
    ai_title: "Stromrechnung",
    ai_issue_date: "2026-03-01",
    ai_confidence: 0.9,
    low_confidence: false,
    ai_error_message: null,
    ai_reference_numbers: null,
    ai_suggested_tags: null,
    ai_summary_de: null,
    ai_backend: null,
    ai_model: null,
    ai_confidence_reason: null,
    content_excerpt: "",
    tags: ["ai-propagated"],
    type_fields: { gesamtbetrag: "EUR21.42", iban: "DE00" },
    ...overrides,
  };
}

const SCHEMA = {
  Rechnung: [
    { name: "gesamtbetrag", label_de: "Gesamtbetrag (brutto)", field_type: "money" },
    { name: "iban", label_de: "IBAN", field_type: "string" },
  ],
  Sonstiges: [],
};

beforeEach(() => {
  useNuxtApp().$queryClient.clear();
  for (const fn of [get, post, patch, del]) fn.mockReset();
  current = detail();
  get.mockImplementation((path: string) => {
    if (path === "/auth/me") return Promise.resolve({ username: "admin" });
    if (path === "/documents/12/detail") return Promise.resolve(current);
    if (path === "/document-types/schema") return Promise.resolve(SCHEMA);
    if (path === "/documents/12/duplicate-candidates") {
      return Promise.resolve({
        doc_id: 12,
        candidates: [
          {
            id: 9,
            title: "Stromrechnung (Kopie)",
            original_file_name: null,
            correspondent: "Stadtwerke",
            document_type: "Rechnung",
            created: "2026-03-01",
            lifecycle_tags: [],
            tags: [],
            ai_error_message: null,
          },
        ],
      });
    }
    return new Promise(() => undefined);
  });
  post.mockResolvedValue({ doc_id: 12 });
  del.mockResolvedValue({ doc_id: 12 });
});

async function render() {
  const wrapper = await mountSuspended(LibraryDetailPage, { route: "/library/12" });
  await vi.waitFor(() => expect(wrapper.find('[data-testid="star"]').exists()).toBe(true));
  await flushPromises();
  return wrapper;
}

describe("library detail actions", () => {
  it("stars an unstarred document and unstars a starred one", async () => {
    const wrapper = await render();
    expect(wrapper.find('[data-testid="star"]').attributes("aria-pressed")).toBe("false");
    await wrapper.find('[data-testid="star"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/documents/12/star", {});

    current = detail({ tags: ["ai-propagated", "wichtig"] });
    await useNuxtApp().$queryClient.invalidateQueries();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="star"]').attributes("aria-pressed")).toBe("true"),
    );
    await wrapper.find('[data-testid="star"]').trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/documents/12/star");
  });

  it("moves the document to the trash only after a second click", async () => {
    const wrapper = await render();
    await wrapper.find('[data-testid="delete"]').trigger("click");
    expect(del).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="delete"]').text()).toContain("Erneut klicken");
    await wrapper.find('[data-testid="delete"]').trigger("click");
    await flushPromises();
    expect(del).toHaveBeenCalledWith("/documents/12");
    await vi.waitFor(() => expect(useRoute().path).toBe("/library"));
  });

  it("shows the duplicate candidates and dismisses the flag", async () => {
    current = detail({ tags: ["ai-propagated", "ai-duplicate"] });
    const wrapper = await render();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="duplicate-panel"]').text()).toContain("#9"));
    expect(wrapper.find('a[href="/library/9"]').exists()).toBe(true);
    await wrapper.find('[data-testid="dismiss-duplicate"]').trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith("/documents/12/dismiss-duplicate", {});
  });

  it("hides the duplicate panel when the document is not flagged", async () => {
    const wrapper = await render();
    expect(wrapper.find('[data-testid="duplicate-panel"]').exists()).toBe(false);
  });

  it("edits type-specific fields and sends only the changes, clearing emptied ones", async () => {
    patch.mockResolvedValue({ document_type: "Rechnung", fields: { gesamtbetrag: "EUR30.00" } });
    const wrapper = await render();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="type-fields"]').exists()).toBe(true));
    expect((wrapper.find('input[name="type-field-gesamtbetrag"]').element as HTMLInputElement).value).toBe("EUR21.42");
    expect(wrapper.find('[data-testid="save-type-fields"]').attributes("disabled")).toBeDefined();

    await wrapper.find('input[name="type-field-gesamtbetrag"]').setValue("30,00 EUR");
    await wrapper.find('input[name="type-field-iban"]').setValue("");
    await wrapper.find('[data-testid="save-type-fields"]').trigger("click");
    await flushPromises();

    expect(patch).toHaveBeenCalledWith("/documents/12/type-fields", {
      document_type: "Rechnung",
      fields: { gesamtbetrag: "30,00 EUR", iban: null },
    });
  });

  it("renders no type-field section for a type without fields", async () => {
    current = detail({ ai_document_type: "Sonstiges", type_fields: null });
    const wrapper = await render();
    expect(wrapper.find('[data-testid="type-fields"]').exists()).toBe(false);
  });
});
