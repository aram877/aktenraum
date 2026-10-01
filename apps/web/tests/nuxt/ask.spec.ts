import { flushPromises } from "@vue/test-utils";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AskPage from "~/pages/ask.vue";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));

function controlledStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

describe("ask page", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    useNuxtApp().$queryClient.clear();
    get.mockReset();
    get.mockResolvedValue({ username: "admin" });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function submit(question: string) {
    const wrapper = await mountSuspended(AskPage, { route: "/ask" });
    await wrapper.find('input[name="question"]').setValue(question);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    return wrapper;
  }

  it("renders the answer as chunks arrive, then the citations from final", async () => {
    const stream = controlledStream();
    fetchMock.mockResolvedValue(new Response(stream.body, { status: 200 }));
    const wrapper = await submit("Was kostete Strom?");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/answer/stream");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({ question: "Was kostete Strom?" });

    stream.push('event: meta\ndata: {"explanation":"Rechnungen","total":2,"filter":{}}\n\n');
    stream.push('event: chunk\ndata: {"text":"Im März "}\n\n');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ask-answer"]').text()).toContain("Im März"));
    expect(wrapper.find('[data-testid="ask-meta"]').text()).toBe("Rechnungen · 2 Treffer");
    expect(wrapper.find('[data-testid="ask-stop"]').exists()).toBe(true);

    stream.push('event: chunk\ndata: {"text":"42 EUR."}\n\n');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ask-answer"]').text()).toContain("Im März 42 EUR."));

    stream.push(
      'event: final\ndata: {"answer_de":"Im März 42 EUR.","total":1,"citations":[{"id":7,"title":"Stromrechnung","original_file_name":null,"correspondent":"Stadtwerke","document_type":"Rechnung","created":"2026-03-01","lifecycle_tags":[],"tags":[],"ai_error_message":null}]}\n\n',
    );
    stream.close();
    await vi.waitFor(() => expect(wrapper.text()).toContain("Stromrechnung"));
    expect(wrapper.find('a[href="/library/7"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ask-submit"]').exists()).toBe(true);
  });

  it("shows the error event as an error state", async () => {
    const stream = controlledStream();
    fetchMock.mockResolvedValue(new Response(stream.body, { status: 200 }));
    const wrapper = await submit("Frage");
    stream.push('event: error\ndata: {"detail":"LLM nicht erreichbar"}\n\n');
    stream.close();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ask-error"]').text()).toBe("LLM nicht erreichbar"));
  });

  it("surfaces the API detail when the request itself fails", async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"Nicht angemeldet"}', { status: 401 }));
    const wrapper = await submit("Frage");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ask-error"]').text()).toBe("Nicht angemeldet"));
  });

  it("stops streaming and reports an error when the stream ends without a final event", async () => {
    const stream = controlledStream();
    fetchMock.mockResolvedValue(new Response(stream.body, { status: 200 }));
    const wrapper = await submit("Frage");
    stream.push('event: chunk\ndata: {"text":"Halbe Antw"}\n\n');
    stream.close();
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="ask-error"]').text()).toContain("Verbindung wurde unterbrochen"),
    );
    expect(wrapper.find('[data-testid="ask-stop"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ask-submit"]').exists()).toBe(true);
  });
});
