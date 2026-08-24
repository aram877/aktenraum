import { describe, expect, it } from "vitest";

import {
  buildDirtyPatch,
  detailToForm,
  EMPTY_FORM,
  mergeHydration,
  pickNeighbour,
  type InboxDetail,
} from "../core/inbox";
import { isFormFocused, shouldHandle } from "../core/keyboard";

function detail(overrides: Partial<InboxDetail> = {}): InboxDetail {
  return {
    id: 1,
    title: "t",
    original_file_name: null,
    created: null,
    added: null,
    ai_correspondent: "Vitego",
    ai_document_type: "Beleg",
    ai_title: "Titel",
    ai_issue_date: "2026-07-30",
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
    tags: [],
    type_fields: null,
    ...overrides,
  };
}

describe("buildDirtyPatch", () => {
  it("sends nothing when the form matches the server", () => {
    expect(buildDirtyPatch(detailToForm(detail()), detail())).toEqual({});
  });

  it("sends only the changed field", () => {
    const form = { ...detailToForm(detail()), ai_title: "Neu" };
    expect(buildDirtyPatch(form, detail())).toEqual({ ai_title: "Neu" });
  });

  it("sends null when a field is cleared", () => {
    const form = { ...detailToForm(detail()), ai_correspondent: "" };
    expect(buildDirtyPatch(form, detail())).toEqual({ ai_correspondent: null });
  });

  it("ignores whitespace-only edits", () => {
    const form = { ...detailToForm(detail()), ai_title: "  Titel  " };
    expect(buildDirtyPatch(form, detail())).toEqual({});
  });
});

describe("mergeHydration", () => {
  it("takes the fresh value wholesale on first hydration", () => {
    const next = detailToForm(detail());
    expect(mergeHydration({ ...EMPTY_FORM }, null, next)).toEqual(next);
  });

  it("does NOT clobber a field the user is editing", () => {
    const hydrated = detailToForm(detail());
    const current = { ...hydrated, ai_title: "Meine Änderung" };
    const next = { ...hydrated, ai_title: "Server-Titel" };
    expect(mergeHydration(current, hydrated, next).ai_title).toBe("Meine Änderung");
  });

  it("does update an untouched field when the server changes it", () => {
    const hydrated = detailToForm(detail());
    const current = { ...hydrated, ai_title: "Meine Änderung" };
    const next = { ...hydrated, ai_title: "Server-Titel", ai_correspondent: "Neu GmbH" };
    const merged = mergeHydration(current, hydrated, next);
    expect(merged.ai_correspondent).toBe("Neu GmbH");
    expect(merged.ai_title).toBe("Meine Änderung");
  });

  it("returns the same object when nothing changed, so signals do not churn", () => {
    const hydrated = detailToForm(detail());
    const current = { ...hydrated };
    expect(mergeHydration(current, hydrated, hydrated)).toBe(current);
  });
});

describe("pickNeighbour", () => {
  it("moves to the next id after the current one", () => {
    expect(pickNeighbour([1, 2, 3], 2, "next")).toBe(3);
  });

  it("moves to the previous id", () => {
    expect(pickNeighbour([1, 2, 3], 2, "prev")).toBe(1);
  });

  it("wraps to the first when the current doc is last", () => {
    expect(pickNeighbour([1, 2, 3], 3, "next")).toBe(1);
  });

  it("returns undefined when the current doc is the only one left", () => {
    expect(pickNeighbour([7], 7, "next")).toBeUndefined();
  });

  it("falls back sensibly when the current id is not in the list", () => {
    expect(pickNeighbour([1, 2], 99, "next")).toBe(1);
    expect(pickNeighbour([1, 2], 99, "prev")).toBe(2);
  });
});

describe("keyboard shortcut gating", () => {
  function el(tag: string, contentEditable?: string): Element {
    const node = document.createElement(tag);
    if (contentEditable !== undefined) node.setAttribute("contenteditable", contentEditable);
    return node;
  }

  it("suppresses shortcuts while a form control has focus", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isFormFocused(el(tag))).toBe(true);
    }
    expect(isFormFocused(el("div"))).toBe(false);
    expect(isFormFocused(el("div", "true"))).toBe(true);
  });

  it("ignores modified key presses so browser shortcuts still work", () => {
    const plain = { metaKey: false, ctrlKey: false, altKey: false };
    expect(shouldHandle(plain, el("div"))).toBe(true);
    expect(shouldHandle({ ...plain, metaKey: true }, el("div"))).toBe(false);
    expect(shouldHandle({ ...plain, ctrlKey: true }, el("div"))).toBe(false);
    expect(shouldHandle(plain, el("input"))).toBe(false);
  });
});
