import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";

import { AAGUID_GOOGLE, ExcludedCredentialError, SoftAuthenticator, TEST_ORIGIN } from "./soft-authenticator.js";

const RP_ID = "localhost";

async function registered(authenticator = new SoftAuthenticator()) {
  const options = await generateRegistrationOptions({
    rpName: "aktenraum",
    rpID: RP_ID,
    userName: "alice",
    userID: new Uint8Array(64).fill(1),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const response = authenticator.register(options, { prf: true });
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: TEST_ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  const info = result.registrationInfo!;
  const credential: WebAuthnCredential = {
    id: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
  };
  return { authenticator, options, response, result, credential };
}

async function assertion(authenticator: SoftAuthenticator, credential: WebAuthnCredential, overrides = {}) {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required" });
  const response = authenticator.authenticate(options, overrides);
  return verifyAuthenticationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: TEST_ORIGIN,
    expectedRPID: RP_ID,
    credential,
    requireUserVerification: true,
  });
}

describe("SoftAuthenticator", () => {
  it("registers a credential the server accepts", async () => {
    const { result, response } = await registered();
    expect(result.verified).toBe(true);
    expect(result.registrationInfo!.aaguid).toBe(AAGUID_GOOGLE);
    expect(result.registrationInfo!.credentialDeviceType).toBe("multiDevice");
    expect(result.registrationInfo!.credentialBackedUp).toBe(true);
    expect(result.registrationInfo!.credential.id).toBe(response.id);
  });

  it("reports device-bound credentials", async () => {
    const { result } = await registered(new SoftAuthenticator({ synced: false }));
    expect(result.registrationInfo!.credentialDeviceType).toBe("singleDevice");
  });

  it("produces assertions the server accepts, with a rising counter", async () => {
    const { authenticator, credential } = await registered();
    const first = await assertion(authenticator, credential);
    expect(first.verified).toBe(true);
    expect(first.authenticationInfo.newCounter).toBe(1);
    expect(first.authenticationInfo.userVerified).toBe(true);
  });

  it("registration: wrong origin, missing UV and wrong challenge are rejected", async () => {
    for (const overrides of [{ origin: "http://evil.example" }, { uv: false }, { challenge: "AAAA" }]) {
      const authenticator = new SoftAuthenticator();
      const options = await generateRegistrationOptions({
        rpName: "aktenraum",
        rpID: RP_ID,
        userName: "alice",
        userID: new Uint8Array(64).fill(1),
        attestationType: "none",
      });
      const response = authenticator.register(options, overrides);
      await expect(
        verifyRegistrationResponse({
          response,
          expectedChallenge: options.challenge,
          expectedOrigin: TEST_ORIGIN,
          expectedRPID: RP_ID,
          requireUserVerification: true,
        }),
      ).rejects.toThrow();
    }
  });

  it("assertion: wrong origin, missing UV, wrong challenge, bad signature and counter regression are rejected", async () => {
    const { authenticator, credential } = await registered();
    for (const overrides of [{ origin: "http://evil.example" }, { uv: false }, { challenge: "AAAA" }]) {
      await expect(assertion(authenticator, credential, overrides)).rejects.toThrow();
    }
    const badSig = await assertion(authenticator, credential, { badSignature: true }).catch(() => ({ verified: false }));
    expect(badSig.verified).toBe(false);
    await expect(assertion(authenticator, { ...credential, counter: 50 }, { counter: 3 })).rejects.toThrow(/counter/i);
  });

  it("honours excludeCredentials like a browser", async () => {
    const { authenticator, response } = await registered();
    const options = await generateRegistrationOptions({
      rpName: "aktenraum",
      rpID: RP_ID,
      userName: "alice",
      userID: new Uint8Array(64).fill(1),
      excludeCredentials: [{ id: response.id }],
    });
    expect(() => authenticator.register(options)).toThrow(ExcludedCredentialError);
  });
});
