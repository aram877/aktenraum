import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANCELLED_MESSAGE,
  PasskeyCancelledError,
  confirmWithPasskey,
  createPasskey,
  passkeyAddressProblem,
  passkeyErrorMessage,
  withStepUp,
} from "~/utils/passkeys";
import { fetchError } from "../fetch-error";

const { startAuthentication, startRegistration } = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration }));

const stepUpRequired = () => fetchError(403, { detail: "step_up_required" });

describe("withStepUp", () => {
  beforeEach(() => {
    startAuthentication.mockReset();
    startRegistration.mockReset();
  });

  it("passes a successful request straight through", async () => {
    const confirm = vi.fn();
    expect(await withStepUp(async () => "ok", confirm)).toBe("ok");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms once and repeats the request once", async () => {
    const request = vi.fn().mockRejectedValueOnce(stepUpRequired()).mockResolvedValueOnce({ emptied: 3 });
    const confirm = vi.fn().mockResolvedValue(undefined);
    expect(await withStepUp(request, confirm)).toEqual({ emptied: 3 });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not loop when the repeated request is refused again", async () => {
    const request = vi.fn().mockRejectedValue(stepUpRequired());
    const confirm = vi.fn().mockResolvedValue(undefined);
    await expect(withStepUp(request, confirm)).rejects.toMatchObject({ statusCode: 403 });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces a cancelled dialog with the German message and does not repeat", async () => {
    const request = vi.fn().mockRejectedValue(stepUpRequired());
    startAuthentication.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    const post = vi.fn().mockResolvedValue({ ceremony: "c", options: { challenge: "x" } });
    const error = await withStepUp(request, () => confirmWithPasskey(post)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasskeyCancelledError);
    expect((error as Error).message).toBe(CANCELLED_MESSAGE);
    expect(request).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1); // begin only, no finish
  });

  it("sends enrolment_required to the enrolment page and rethrows other errors untouched", async () => {
    const onEnrol = vi.fn();
    const confirm = vi.fn();
    await expect(withStepUp(() => Promise.reject(fetchError(403, { detail: "enrolment_required" })), confirm, onEnrol)).rejects.toBeDefined();
    expect(onEnrol).toHaveBeenCalledTimes(1);
    await expect(withStepUp(() => Promise.reject(fetchError(404)), confirm, onEnrol)).rejects.toMatchObject({ statusCode: 404 });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("confirmWithPasskey", () => {
  beforeEach(() => startAuthentication.mockReset());

  it("runs begin → passkey → finish through the step-up endpoints", async () => {
    startAuthentication.mockResolvedValue({ id: "cred" });
    const post = vi.fn().mockResolvedValueOnce({ ceremony: "c1", options: { challenge: "x" } }).mockResolvedValueOnce(undefined);
    await confirmWithPasskey(post);
    expect(post).toHaveBeenNthCalledWith(1, "/auth/step-up/begin");
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "x" } });
    expect(post).toHaveBeenNthCalledWith(2, "/auth/step-up/finish", { ceremony: "c1", response: { id: "cred" } });
  });

  it("shares one dialog between parallel requests", async () => {
    startAuthentication.mockResolvedValue({ id: "cred" });
    const post = vi.fn().mockResolvedValueOnce({ ceremony: "c1", options: {} }).mockResolvedValue(undefined);
    await Promise.all([confirmWithPasskey(post), confirmWithPasskey(post)]);
    expect(startAuthentication).toHaveBeenCalledTimes(1);
  });
});

describe("passkey helpers", () => {
  it("knows where passkeys can't work", () => {
    const origins = ["http://localhost:8080", "https://box.tail1234.ts.net"];
    expect(passkeyAddressProblem("http://localhost:8080", origins)).toBeNull();
    expect(passkeyAddressProblem("https://box.tail1234.ts.net", origins)).toBeNull();
    expect(passkeyAddressProblem("http://192.168.1.5:8080", origins)).toBe("ip");
    expect(passkeyAddressProblem("http://[::1]:8080", origins)).toBe("ip");
    expect(passkeyAddressProblem("http://aktenraum.lan:8080", origins)).toBe("unconfigured");
  });

  it("translates an existing credential and maps API errors to German", async () => {
    startRegistration.mockRejectedValue(Object.assign(new Error("dup"), { name: "InvalidStateError" }));
    const error = await createPasskey({} as never).catch((e: unknown) => e);
    expect(passkeyErrorMessage(error, "x")).toContain("schon einen Passkey");
    expect(passkeyErrorMessage(fetchError(429), "x")).toContain("Zu viele Versuche");
    expect(passkeyErrorMessage(fetchError(401, { detail: "Passkey nicht akzeptiert" }), "x")).toBe("Der Passkey wurde nicht akzeptiert.");
  });
});
