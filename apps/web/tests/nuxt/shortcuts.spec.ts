import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

function harness(enabled = ref(true)) {
  const approve = vi.fn();
  const Comp = defineComponent({
    setup() {
      useShortcuts(() => ({ a: approve }), enabled);
      return () => h("div", [h("input", { "data-testid": "field" })]);
    },
  });
  return { wrapper: mount(Comp, { attachTo: document.body }), approve, enabled };
}

describe("useShortcuts", () => {
  it("fires the bound handler for a plain key press", () => {
    const { wrapper, approve } = harness();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(approve).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("does not approve while the user types into a field", () => {
    const { wrapper, approve } = harness();
    const input = wrapper.find('[data-testid="field"]').element as HTMLInputElement;
    input.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(approve).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("stays quiet while disabled", () => {
    const { wrapper, approve } = harness(ref(false));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(approve).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("removes the listener on unmount", () => {
    const { wrapper, approve } = harness();
    wrapper.unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(approve).not.toHaveBeenCalled();
  });
});
