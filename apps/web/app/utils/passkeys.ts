import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { detailFrom, statusOf } from "./errors";

/**
 * Passkeys in the browser (auth-passkeys): the ceremony wrappers around
 * @simplewebauthn/browser, the address check for the login page and the
 * step-up retry used by `useApi`.
 */

export interface CeremonyStart<T> {
  ceremony: string;
  options: T;
}

export const STEP_UP_REQUIRED = "step_up_required";
export const ENROLMENT_REQUIRED = "enrolment_required";
export const CANCELLED_MESSAGE = "Bestätigung abgebrochen.";

/** The person closed or declined the passkey dialog (or it timed out). */
export class PasskeyCancelledError extends Error {
  constructor() {
    super(CANCELLED_MESSAGE);
    this.name = "PasskeyCancelledError";
  }
}

/** The authenticator already holds a passkey for this account (excludeCredentials). */
export class PasskeyExistsError extends Error {
  constructor() {
    super("Auf diesem Gerät gibt es schon einen Passkey für dein Konto.");
    this.name = "PasskeyExistsError";
  }
}

function translate(error: unknown): never {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") {
    throw new PasskeyCancelledError();
  }
  if (name === "InvalidStateError" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    throw new PasskeyExistsError();
  }
  throw error;
}

export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  try {
    return await startRegistration({ optionsJSON: options });
  } catch (error: unknown) {
    return translate(error);
  }
}

export async function getPasskeyAssertion(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  try {
    return await startAuthentication({ optionsJSON: options });
  } catch (error: unknown) {
    return translate(error);
  }
}

/** A user-facing message for a failed ceremony or its API call. */
export function passkeyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PasskeyCancelledError || error instanceof PasskeyExistsError) return error.message;
  const status = statusOf(error);
  if (status === 429) return "Zu viele Versuche. Bitte später erneut versuchen.";
  if (status === 400) return "Passkeys sind auf dieser Adresse nicht eingerichtet.";
  if (status === 401) return "Der Passkey wurde nicht akzeptiert.";
  return detailFrom(error, fallback);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[");
}

/** Why passkeys can't work on `origin`, or null when they can. */
export function passkeyAddressProblem(origin: string, configured: readonly string[]): "ip" | "unconfigured" | null {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return "unconfigured";
  }
  if (isIpHost(hostname)) return "ip";
  return configured.includes(origin.replace(/\/$/, "")) ? null : "unconfigured";
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

/** The `{detail}` reason of a 403, or null. */
export function forbiddenReason(error: unknown): string | null {
  if (statusOf(error) !== 403) return null;
  const data = (error as { data?: unknown }).data;
  const detail = data !== null && typeof data === "object" ? (data as { detail?: unknown }).detail : undefined;
  return typeof detail === "string" ? detail : null;
}

/**
 * Runs `request`; on 403 `step_up_required` asks for a passkey confirmation
 * (`confirm`) and repeats the request exactly once — a second refusal is
 * passed through, never looped. On 403 `enrolment_required` calls
 * `onEnrolmentRequired` and rethrows.
 */
export async function withStepUp<T>(
  request: () => Promise<T>,
  confirm: () => Promise<void>,
  onEnrolmentRequired?: () => void,
): Promise<T> {
  try {
    return await request();
  } catch (error: unknown) {
    const reason = forbiddenReason(error);
    if (reason === ENROLMENT_REQUIRED) onEnrolmentRequired?.();
    if (reason !== STEP_UP_REQUIRED) throw error;
  }
  await confirm();
  return request();
}

type Poster = <T>(path: string, body?: unknown) => Promise<T>;

let inFlight: Promise<void> | null = null;

/**
 * One passkey confirmation through the step-up endpoints. Parallel requests
 * that all need it share the same dialog.
 */
export function confirmWithPasskey(post: Poster): Promise<void> {
  inFlight ??= (async () => {
    try {
      const begin = await post<CeremonyStart<PublicKeyCredentialRequestOptionsJSON>>("/auth/step-up/begin");
      const response = await getPasskeyAssertion(begin.options);
      await post<unknown>("/auth/step-up/finish", { ceremony: begin.ceremony, response });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
