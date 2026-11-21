import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { SoftAuthenticator, TEST_ORIGIN } from "./soft-authenticator.js";

/**
 * Drives the auth-passkeys flows over HTTP with the software authenticator.
 * Since passwords only lead to enrolment, every test that needs a full
 * session signs in with the password and enrols a passkey first.
 */

export const ORIGIN = TEST_ORIGIN;

export type Agent = ReturnType<typeof request.agent>;

export interface Enrolled {
  authenticator: SoftAuthenticator;
  recoveryCodes: string[] | null;
  passkeyId: number;
}

/** Enrols (restricted session) or adds (full session + step-up) a passkey. */
export async function registerPasskey(
  agent: Agent,
  authenticator: SoftAuthenticator = new SoftAuthenticator(),
  options: { name?: string } = {},
): Promise<Enrolled> {
  const begin = await agent.post("/api/auth/passkeys/register/begin").set("Origin", ORIGIN).send({}).expect(200);
  const response = authenticator.register(begin.body.options);
  const finish = await agent
    .post("/api/auth/passkeys/register/finish")
    .set("Origin", ORIGIN)
    .send({ ceremony: begin.body.ceremony, response, ...(options.name ? { name: options.name } : {}) })
    .expect(200);
  return {
    authenticator,
    recoveryCodes: finish.body.recovery_codes as string[] | null,
    passkeyId: finish.body.passkey.id as number,
  };
}

export async function passwordLogin(app: INestApplication, username: string, password: string): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post("/api/auth/login").send({ username, password }).expect(200);
  return agent;
}

/** Password login + enrolment → a full `passkey` session (with a fresh step-up). */
export async function loginEnrolled(
  app: INestApplication,
  username: string,
  password: string,
): Promise<Agent & { enrolled: Enrolled }> {
  const agent = await passwordLogin(app, username, password);
  const enrolled = await registerPasskey(agent);
  return Object.assign(agent, { enrolled });
}

/** A discoverable passkey sign-in on a new agent. */
export async function passkeyLogin(
  app: INestApplication,
  authenticator: SoftAuthenticator,
  expectStatus = 200,
): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  const begin = await agent.post("/api/auth/passkeys/login/begin").set("Origin", ORIGIN).send({}).expect(200);
  await agent
    .post("/api/auth/passkeys/login/finish")
    .set("Origin", ORIGIN)
    .send({ ceremony: begin.body.ceremony, response: authenticator.authenticate(begin.body.options) })
    .expect(expectStatus);
  return agent;
}

/** Confirms the session with one of the authenticator's passkeys. */
export async function stepUp(agent: Agent, authenticator: SoftAuthenticator, expectStatus = 204): Promise<void> {
  const begin = await agent.post("/api/auth/step-up/begin").set("Origin", ORIGIN).send({}).expect(200);
  await agent
    .post("/api/auth/step-up/finish")
    .set("Origin", ORIGIN)
    .send({ ceremony: begin.body.ceremony, response: authenticator.authenticate(begin.body.options) })
    .expect(expectStatus);
}

/** Redeems an invite with a username and a new passkey. */
export async function joinWithInvite(
  app: INestApplication,
  token: string,
  username: string,
  options: { ip?: string; authenticator?: SoftAuthenticator } = {},
): Promise<{ agent: Agent; authenticator: SoftAuthenticator; recoveryCodes: string[] | null; response: request.Response }> {
  const agent = request.agent(app.getHttpServer());
  if (options.ip !== undefined) agent.set("X-Forwarded-For", options.ip);
  const authenticator = options.authenticator ?? new SoftAuthenticator();
  const begin = await agent
    .post(`/api/invites/${token}/register/begin`)
    .set("Origin", ORIGIN)
    .send({ username })
    .expect(200);
  const response = await agent
    .post(`/api/invites/${token}/register/finish`)
    .set("Origin", ORIGIN)
    .send({ ceremony: begin.body.ceremony, response: authenticator.register(begin.body.options) })
    .expect(200);
  return { agent, authenticator, recoveryCodes: response.body.recovery_codes as string[] | null, response };
}
