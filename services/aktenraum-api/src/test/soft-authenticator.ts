import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software WebAuthn authenticator for tests (auth-passkeys design §12):
 * ES256 key pairs, `none` attestation, discoverable credentials. It builds the
 * exact bytes a browser + platform authenticator would send, so the server
 * verifies them with the real `@simplewebauthn/server` code paths.
 */

export const TEST_ORIGIN = "http://localhost:8080";

/** Google Password Manager — a synced provider, as seen in the spike. */
export const AAGUID_GOOGLE = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";
/** Windows Hello — device-bound. */
export const AAGUID_WINDOWS_HELLO = "08987058-cadc-4b81-b6e1-30de50dcbe96";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface SoftCredential {
  id: string;
  rawId: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
}

export interface SoftAuthenticatorOptions {
  origin?: string;
  aaguid?: string;
  /** Synced passkey (backup eligible + backed up). Default true. */
  synced?: boolean;
  /** Counter increment per assertion; 0 = like synced passkeys. Default 1. */
  counterStep?: number;
}

export interface RegisterOverrides {
  origin?: string;
  challenge?: string;
  /** false = the authenticator reports no user verification. */
  uv?: boolean;
  /** Report the PRF extension as enabled. */
  prf?: boolean;
  /** Ignore excludeCredentials (to test the server-side duplicate check). */
  ignoreExclude?: boolean;
}

export interface AuthenticateOverrides {
  origin?: string;
  challenge?: string;
  uv?: boolean;
  credential?: SoftCredential;
  /** Report this counter instead of the next one. */
  counter?: number;
  userHandle?: string;
  /** Flip a byte in the signature. */
  badSignature?: boolean;
}

export class ExcludedCredentialError extends Error {
  constructor() {
    super("InvalidStateError: the authenticator already holds an excluded credential");
  }
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

function aaguidBytes(aaguid: string): Buffer {
  return Buffer.from(aaguid.replace(/-/g, ""), "hex");
}

function coseKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" });
  const map = new Map<number, number | Uint8Array>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x!, "base64url")],
    [-3, Buffer.from(jwk.y!, "base64url")],
  ]);
  return isoCBOR.encode(map);
}

function counterBytes(counter: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(counter >>> 0);
  return out;
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export class SoftAuthenticator {
  readonly credentials: SoftCredential[] = [];
  private readonly origin: string;
  private readonly aaguid: string;
  private readonly synced: boolean;
  private readonly counterStep: number;

  constructor(options: SoftAuthenticatorOptions = {}) {
    this.origin = options.origin ?? TEST_ORIGIN;
    this.aaguid = options.aaguid ?? AAGUID_GOOGLE;
    this.synced = options.synced ?? true;
    this.counterStep = options.counterStep ?? 1;
  }

  private flags(uv: boolean, attested: boolean): number {
    let flags = FLAG_UP;
    if (uv) flags |= FLAG_UV;
    if (this.synced) flags |= FLAG_BE | FLAG_BS;
    if (attested) flags |= FLAG_AT;
    return flags;
  }

  /** navigator.credentials.create(): a new discoverable credential. */
  register(options: PublicKeyCredentialCreationOptionsJSON, overrides: RegisterOverrides = {}): RegistrationResponseJSON {
    const rpId = options.rp.id ?? new URL(overrides.origin ?? this.origin).hostname;
    if (!overrides.ignoreExclude) {
      const excluded = new Set((options.excludeCredentials ?? []).map((c) => c.id));
      if (this.credentials.some((c) => c.rpId === rpId && excluded.has(c.id))) throw new ExcludedCredentialError();
    }
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rawId = randomBytes(32);
    const credential: SoftCredential = {
      id: b64(rawId),
      rawId,
      privateKey,
      publicKey,
      rpId,
      userHandle: options.user.id,
      counter: 0,
    };
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(rawId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(overrides.uv ?? true, true)]),
      counterBytes(0),
      aaguidBytes(this.aaguid),
      idLength,
      rawId,
      Buffer.from(coseKey(publicKey)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map<string, unknown>()],
        ["authData", new Uint8Array(authData)],
      ]) as Parameters<typeof isoCBOR.encode>[0],
    );
    this.credentials.push(credential);
    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: b64(clientData("webauthn.create", overrides.challenge ?? options.challenge, overrides.origin ?? this.origin)),
        attestationObject: b64(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: overrides.prf ? ({ prf: { enabled: true } } as never) : {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get(): an assertion with one of our credentials. */
  authenticate(options: PublicKeyCredentialRequestOptionsJSON, overrides: AuthenticateOverrides = {}): AuthenticationResponseJSON {
    const rpId = options.rpId ?? new URL(overrides.origin ?? this.origin).hostname;
    const allowed = new Set((options.allowCredentials ?? []).map((c) => c.id));
    const credential =
      overrides.credential ??
      this.credentials.find((c) => c.rpId === rpId && (allowed.size === 0 || allowed.has(c.id)));
    if (credential === undefined) throw new Error("NotAllowedError: no matching credential");
    credential.counter = overrides.counter ?? credential.counter + this.counterStep;
    const authData = Buffer.concat([
      sha256(credential.rpId),
      Buffer.from([this.flags(overrides.uv ?? true, false)]),
      counterBytes(credential.counter),
    ]);
    const clientDataJSON = clientData("webauthn.get", overrides.challenge ?? options.challenge, overrides.origin ?? this.origin);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), credential.privateKey);
    if (overrides.badSignature) signature.writeUInt8(signature.readUInt8(signature.length - 1) ^ 0xff, signature.length - 1);
    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: overrides.userHandle ?? credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
