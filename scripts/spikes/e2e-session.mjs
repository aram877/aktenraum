// Prints a full (passkey, freshly stepped-up) session cookie value for the
// e2e stack's admin — for scripts/e2e-worker.sh, which used to log in with the
// password (auth-passkeys: a password session may only enrol). Uses the host
// CLI setup link, so it works on a fresh stack and on every re-run.
// THROWAWAY e2e stack only (port 8102).
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SoftAuthenticator, browser, register } from "./soft-authenticator.mjs";

const API = process.env.E2E_API ?? "http://127.0.0.1:8102";
const COMPOSE = `docker compose -f "${fileURLToPath(new URL("../../docker/docker-compose.e2e.yml", import.meta.url))}"`;

const link = execSync(`${COMPOSE} exec -T aktenraum-api node dist/auth/setup-link-cli.js admin`, {
  encoding: "utf8",
  env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  stdio: ["ignore", "pipe", "ignore"],
}).trim();
const token = link.split("/setup/")[1];
const client = browser(API);
const { finish } = await register(client, `/api/setup/${token}/register`, new SoftAuthenticator());
if (finish?.status !== 200 || !client.cookie()) {
  console.error(`setup-link enrolment failed: ${finish?.status} ${JSON.stringify(finish?.body)}`);
  process.exit(1);
}
process.stdout.write(`${client.cookie()}\n`);
