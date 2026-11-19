import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts members' Paperless API tokens at rest (ADR-010 §8): AES-256-GCM
 * under `AKTENRAUM_SECRET_KEY`, a fresh 12-byte IV per token, the GCM tag kept
 * beside it. `keyId` (first 16 hex of the key's SHA-256) tells which key
 * sealed a row, so a changed key is noticed before decryption is attempted —
 * the token is then simply re-minted.
 */

export interface SealedToken {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
}

export class TokenVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenVaultError";
  }
}

export class TokenVault {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new TokenVaultError("token key must be 32 bytes");
    this.keyId = createHash("sha256").update(this.key).digest("hex").slice(0, 16);
  }

  seal(token: string): SealedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("hex"),
      authTag: cipher.getAuthTag().toString("hex"),
      keyId: this.keyId,
    };
  }

  /** Throws `TokenVaultError` for a different key or tampered data. */
  open(sealed: SealedToken): string {
    if (sealed.keyId !== this.keyId) throw new TokenVaultError("sealed with a different key");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "hex"));
      decipher.setAuthTag(Buffer.from(sealed.authTag, "hex"));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new TokenVaultError("token could not be decrypted");
    }
  }
}
