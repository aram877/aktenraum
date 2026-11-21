// Software WebAuthn authenticator for the e2e rehearsals (auth-passkeys design
// §12) — the plain-JS twin of services/aktenraum-api/src/test/soft-authenticator.ts,
// with a tiny CBOR encoder so it needs no dependencies. ES256, `none`
// attestation, discoverable credentials, UP + UV flags. Throwaway stacks only.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export const ORIGIN = "http://localhost:8080";
const AAGUID_GOOGLE = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();

// --- minimal CBOR (major types 0, 1, 2, 3, 5) ------------------------------
function head(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}
function cbor(value) {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

function coseKey(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
}

const counterBytes = (n) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n >>> 0);
  return out;
};
const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

export class SoftAuthenticator {
  constructor({ origin = ORIGIN } = {}) {
    this.origin = origin;
    this.credentials = [];
  }

  register(options) {
    const rpId = options.rp.id;
    const excluded = new Set((options.excludeCredentials ?? []).map((c) => c.id));
    if (this.credentials.some((c) => c.rpId === rpId && excluded.has(c.id))) throw new Error("InvalidStateError");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rawId = randomBytes(32);
    const credential = { id: b64(rawId), privateKey, rpId, userHandle: options.user.id, counter: 0 };
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(rawId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x01 | 0x04 | 0x08 | 0x10 | 0x40]), // UP UV BE BS AT
      counterBytes(0),
      Buffer.from(AAGUID_GOOGLE.replace(/-/g, ""), "hex"),
      idLength,
      rawId,
      coseKey(publicKey),
    ]);
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    this.credentials.push(credential);
    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: b64(clientData("webauthn.create", options.challenge, this.origin)),
        attestationObject: b64(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  authenticate(options, { credential, badSignature = false } = {}) {
    const allowed = new Set((options.allowCredentials ?? []).map((c) => c.id));
    const cred = credential ?? this.credentials.find((c) => c.rpId === options.rpId && (allowed.size === 0 || allowed.has(c.id)));
    if (!cred) throw new Error("NotAllowedError: no matching credential");
    cred.counter += 1;
    const authData = Buffer.concat([sha256(cred.rpId), Buffer.from([0x01 | 0x04 | 0x08 | 0x10]), counterBytes(cred.counter)]);
    const cdj = clientData("webauthn.get", options.challenge, this.origin);
    const signature = sign("sha256", Buffer.concat([authData, sha256(cdj)]), cred.privateKey);
    if (badSignature) signature[signature.length - 1] ^= 0xff;
    return {
      id: cred.id,
      rawId: cred.id,
      type: "public-key",
      response: { clientDataJSON: b64(cdj), authenticatorData: b64(authData), signature: b64(signature), userHandle: cred.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

/** A cookie-jar fetch client against one base URL, playing one browser. */
export function browser(base, { ip, userAgent = "aktenraum-rehearsal" } = {}) {
  const jar = new Map();
  async function call(method, path, body, extraHeaders = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "user-agent": userAgent,
        ...(ip ? { "x-forwarded-for": ip } : {}),
        ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const value = pair.slice(i + 1);
      if (value === "") jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), value);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  return { jar, call, cookie: () => jar.get("aktenraum_session") ?? null };
}

/** begin → ceremony → finish for registration-style flows. */
export async function register(client, prefix, authenticator, beginBody = {}) {
  const begin = await client.call("POST", `${prefix}/begin`, beginBody);
  if (begin.status !== 200) return { begin, finish: null };
  const finish = await client.call("POST", `${prefix}/finish`, {
    ceremony: begin.body.ceremony,
    response: authenticator.register(begin.body.options),
  });
  return { begin, finish };
}

export async function passkeyLogin(client, authenticator, options = {}) {
  const begin = await client.call("POST", "/api/auth/passkeys/login/begin", {});
  if (begin.status !== 200) return begin;
  return client.call("POST", "/api/auth/passkeys/login/finish", {
    ceremony: begin.body.ceremony,
    response: authenticator.authenticate(begin.body.options, options),
  });
}

export async function stepUp(client, authenticator, options = {}) {
  const begin = await client.call("POST", "/api/auth/step-up/begin", {});
  if (begin.status !== 200) return begin;
  return client.call("POST", "/api/auth/step-up/finish", {
    ceremony: begin.body.ceremony,
    response: authenticator.authenticate(begin.body.options, options),
  });
}
