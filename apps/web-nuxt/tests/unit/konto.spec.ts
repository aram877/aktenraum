import { describe, expect, it } from "vitest";

import { mapChangePasswordError } from "~/utils/settings";

describe("mapChangePasswordError", () => {
  it("maps 401 to the wrong-current-password message", () => {
    expect(mapChangePasswordError(401)).toBe("Aktuelles Passwort ist nicht korrekt.");
  });

  it("maps 400 to the must-differ message", () => {
    expect(mapChangePasswordError(400)).toBe(
      "Das neue Passwort muss sich vom aktuellen unterscheiden.",
    );
  });

  it("maps 422 to the validation message", () => {
    expect(mapChangePasswordError(422)).toContain("min. 8 Zeichen");
  });

  it("falls back for anything else", () => {
    expect(mapChangePasswordError(500)).toBe(
      "Unbekannter Fehler beim Ändern des Passworts.",
    );
    expect(mapChangePasswordError(null)).toBe(
      "Unbekannter Fehler beim Ändern des Passworts.",
    );
  });
});
