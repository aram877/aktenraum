import { describe, expect, it } from "vitest";

import { hasTag, typeFieldsChanges, typeFieldsDraft } from "~/utils/type-fields";

describe("type field helpers", () => {
  const defs = [{ name: "gesamtbetrag" }, { name: "iban" }];

  it("drafts every schema field, empty when unsaved", () => {
    expect(typeFieldsDraft(defs, { gesamtbetrag: "EUR1.00" })).toEqual({ gesamtbetrag: "EUR1.00", iban: "" });
  });

  it("reports only changed fields and turns an emptied one into null", () => {
    expect(
      typeFieldsChanges({ gesamtbetrag: " EUR1.00 ", iban: "" }, { gesamtbetrag: "EUR1.00", iban: "DE00" }),
    ).toEqual({ iban: null });
  });

  it("checks tag membership defensively", () => {
    expect(hasTag(["wichtig"], "wichtig")).toBe(true);
    expect(hasTag(undefined, "wichtig")).toBe(false);
  });
});
