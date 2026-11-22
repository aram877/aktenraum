// Passkey sign-in helpers for the rehearsal scripts (auth-passkeys: password
// sessions may only enrol, and invites / spaces / removals need a step-up).
// THROWAWAY e2e stack only.
//
//   const admin = await adminMember(API, COMPOSE);          // setup link, host CLI
//   const bob = await joinWithPasskey(API, admin, "bob1");  // invite + passkey
//   await bob.call("POST", "/api/spaces/1/members", {...}); // 403 step_up_required → step-up → retried once
//   await bob.upload("a.txt", "text");
import { execSync } from "node:child_process";

import { SoftAuthenticator, browser, register, stepUp } from "./soft-authenticator.mjs";

/** A signed-in member: the browser client, its authenticator and a step-up-aware call. */
function member(api, client, authenticator) {
  async function call(method, path, body) {
    const first = await client.call(method, path, body);
    if (first.status !== 403 || first.body?.detail !== "step_up_required") return first;
    const confirmed = await stepUp(client, authenticator);
    if (confirmed.status !== 204) return first;
    return client.call(method, path, body);
  }
  async function upload(filename, text) {
    const form = new FormData();
    form.append("files", new Blob([text], { type: "text/plain" }), filename);
    const res = await fetch(api + "/api/documents/upload", {
      method: "POST",
      headers: { cookie: `aktenraum_session=${client.cookie()}` },
      body: form,
    });
    const raw = await res.text();
    try {
      return { status: res.status, body: JSON.parse(raw) };
    } catch {
      return { status: res.status, body: raw };
    }
  }
  return { call, upload, cookie: client.cookie, client, authenticator };
}

/** The e2e admin, signed in through a host-CLI setup link with a new software passkey. */
export async function adminMember(api, compose, username = "admin") {
  const link = execSync(`${compose} exec -T aktenraum-api node dist/auth/setup-link-cli.js ${username}`, {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const token = link.split("/setup/")[1];
  const client = browser(api);
  const authenticator = new SoftAuthenticator();
  const { finish } = await register(client, `/api/setup/${token}/register`, authenticator);
  if (finish?.status !== 200 || !client.cookie()) {
    throw new Error(`setup-link enrolment failed: ${finish?.status} ${JSON.stringify(finish?.body)}`);
  }
  return member(api, client, authenticator);
}

/** A new household member: the admin creates an invite, the invitee joins with a passkey. */
export async function joinWithPasskey(api, admin, username) {
  const invite = await admin.call("POST", "/api/household/invites");
  if (invite.status !== 201) throw new Error(`invite for ${username}: ${invite.status} ${JSON.stringify(invite.body)}`);
  const client = browser(api);
  const authenticator = new SoftAuthenticator();
  const { finish } = await register(client, `/api/invites/${invite.body.token}/register`, authenticator, { username });
  if (finish?.status !== 200 || !client.cookie()) {
    throw new Error(`join ${username}: ${finish?.status} ${JSON.stringify(finish?.body)}`);
  }
  return member(api, client, authenticator);
}

/** A client with no session (for "this must be refused" checks). */
export function anonymous(api) {
  return browser(api);
}
