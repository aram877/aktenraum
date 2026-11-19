// WebAuthn spike server — throwaway, scratchpad only. Listens on 127.0.0.1:8790.
// Serves the test page on both http://localhost:8790 and http://127.0.0.1:8790
// so the RP-ID binding can be observed. Every event is appended to results.jsonl.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const RESULTS = join(DIR, "results.jsonl");
const STORE = join(DIR, "credentials.json");

const KNOWN_AAGUIDS = {
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (managed)",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "00000000-0000-0000-0000-000000000000": "unknown (zero AAGUID)",
};

const creds = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : [];
const saveCreds = () => writeFileSync(STORE, JSON.stringify(creds, null, 2));
const challenges = new Map(); // challenge -> { kind, rpID }

function log(event) {
  const line = { at: new Date().toISOString(), ...event };
  appendFileSync(RESULTS, JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line));
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, payload, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(payload) : payload);
}

const server = createServer(async (req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  const origin = `http://${req.headers.host}`;
  try {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      return send(res, 200, readFileSync(join(DIR, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && req.url === "/api/creds") {
      return send(res, 200, creds.map(({ publicKey, ...rest }) => rest));
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const input = await body(req);

    if (req.url === "/api/log") {
      log({ type: "client", origin, ...input });
      return send(res, 200, { ok: true });
    }

    if (req.url === "/api/reg/options") {
      const rpID = input.rpId ?? host;
      const options = await generateRegistrationOptions({
        rpName: "aktenraum spike",
        rpID,
        userName: `spike-${input.client ?? "browser"}`,
        userID: randomBytes(16),
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: [],
      });
      challenges.set(options.challenge, { kind: "reg", rpID });
      return send(res, 200, options);
    }

    if (req.url === "/api/reg/verify") {
      const { credential, challenge, client, prf } = input;
      const pending = challenges.get(challenge);
      if (!pending) return send(res, 400, { error: "unknown challenge" });
      challenges.delete(challenge);
      const result = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: pending.rpID,
        requireUserVerification: true,
      });
      if (!result.verified) {
        log({ type: "register", ok: false, origin, client });
        return send(res, 400, { error: "not verified" });
      }
      const info = result.registrationInfo;
      const entry = {
        id: info.credential.id,
        publicKey: b64(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? credential.response?.transports ?? [],
        rpID: pending.rpID,
        origin,
        client,
        aaguid: info.aaguid,
        authenticator: KNOWN_AAGUIDS[info.aaguid] ?? `aaguid ${info.aaguid}`,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        attachment: credential.authenticatorAttachment ?? null,
        prfAtCreate: prf ?? null,
        createdAt: new Date().toISOString(),
      };
      creds.push(entry);
      saveCreds();
      const { publicKey, ...logged } = entry;
      log({ type: "register", ok: true, ...logged });
      return send(res, 200, { ok: true, credential: logged });
    }

    if (req.url === "/api/auth/options") {
      const rpID = input.rpId ?? host;
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        allowCredentials: [],
      });
      challenges.set(options.challenge, { kind: "auth", rpID });
      return send(res, 200, options);
    }

    if (req.url === "/api/auth/verify") {
      const { credential, challenge, client, prf } = input;
      const pending = challenges.get(challenge);
      if (!pending) return send(res, 400, { error: "unknown challenge" });
      challenges.delete(challenge);
      const stored = creds.find((c) => c.id === credential.id);
      if (!stored) {
        log({ type: "authenticate", ok: false, reason: "credential unknown to server", origin, client });
        return send(res, 400, { error: "credential unknown" });
      }
      const result = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin: ORIGINS,
        expectedRPID: pending.rpID,
        credential: {
          id: stored.id,
          publicKey: Buffer.from(stored.publicKey, "base64url"),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: true,
      });
      if (result.verified) {
        stored.counter = result.authenticationInfo.newCounter;
        saveCreds();
      }
      log({
        type: "authenticate",
        ok: result.verified,
        origin,
        client,
        credentialId: stored.id,
        authenticator: stored.authenticator,
        registeredOrigin: stored.origin,
        rpID: pending.rpID,
        userVerified: result.authenticationInfo.userVerified,
        prf: prf ?? null,
      });
      return send(res, 200, { ok: result.verified, authenticator: stored.authenticator });
    }

    return send(res, 404, { error: "not found" });
  } catch (error) {
    log({ type: "server-error", url: req.url, origin, message: String(error?.message ?? error) });
    return send(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`webauthn spike on ${ORIGINS.join(" and ")} — results in ${RESULTS}`);
});
