import { describe, expect, it } from "vitest";

import { loadSettings } from "../config/settings.js";
import { TEST_ENV } from "../test/harness.js";
import { TokenVault, TokenVaultError } from "./token-vault.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("TokenVault", () => {
  it("round-trips a token and never stores it in clear", () => {
    const vault = new TokenVault(KEY_A);
    const sealed = vault.seal("0123456789abcdef0123456789abcdef01234567");
    expect(sealed.ciphertext).not.toContain("0123456789");
    expect(vault.open(sealed)).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("uses a fresh IV for every token", () => {
    const vault = new TokenVault(KEY_A);
    const a = vault.seal("same");
    const b = vault.seal("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("detects a token sealed with another key without trying to decrypt", () => {
    const sealed = new TokenVault(KEY_A).seal("t");
    expect(() => new TokenVault(KEY_B).open(sealed)).toThrow(new TokenVaultError("sealed with a different key"));
  });

  it("rejects tampered ciphertext or tag", () => {
    const vault = new TokenVault(KEY_A);
    const sealed = vault.seal("secret-token");
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => vault.open({ ...sealed, ciphertext: flipped.toString("base64") })).toThrow(TokenVaultError);
    expect(() => vault.open({ ...sealed, authTag: "00".repeat(16) })).toThrow(TokenVaultError);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => new TokenVault(Buffer.alloc(16).toString("base64"))).toThrow(TokenVaultError);
  });
});

describe("AKTENRAUM_SECRET_KEY setting", () => {
  it("is required and must be 32 base64 bytes", () => {
    const { AKTENRAUM_SECRET_KEY: _omit, ...withoutKey } = TEST_ENV;
    expect(() => loadSettings(withoutKey)).toThrow(/AKTENRAUM_SECRET_KEY/);
    expect(() => loadSettings({ ...TEST_ENV, AKTENRAUM_SECRET_KEY: "too-short" })).toThrow(/32 random bytes/);
    expect(loadSettings(TEST_ENV).AKTENRAUM_SECRET_KEY).toBe(TEST_ENV.AKTENRAUM_SECRET_KEY);
  });
});
