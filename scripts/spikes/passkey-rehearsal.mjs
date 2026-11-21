// Passkeys rehearsal (auth-passkeys) against the THROWAWAY e2e stack (project
// aktenraum-e2e, api on 127.0.0.1:8102 — never the live stack). Run after
// `bash scripts/e2e-worker.sh` (stack up, api built from this tree).
//
// Covers: host-CLI setup link → admin passkey session; a password member →
// restricted (library 403) → enrol → codes → password refused; passkey login;
// empty trash → step_up_required → step-up → OK; recovery code → restricted →
// enrol; admin-issued setup link → old codes dead; invite with a passkey;
// 10 failed passkey logins → 429, still 429 after an api restart; audit rows
// written and free of codes / tokens.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SoftAuthenticator, browser, passkeyLogin, register, stepUp } from "./soft-authenticator.mjs";

const API = "http://127.0.0.1:8102";
const COMPOSE = `docker compose -f "${fileURLToPath(new URL("../../docker/docker-compose.e2e.yml", import.meta.url))}"`;
const RUN = Date.now().toString(36);
const MEMBER = `pw-${RUN}`;
const MEMBER_PASSWORD = "member-password-1";
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const psql = (sql) => sh(`${COMPOSE} exec -T postgres psql -U paperless -d aktenraum -tA -c "${sql.replace(/"/g, '\\"')}"`);
const secrets = [];

console.log("1. host CLI setup link → admin passkey session");
const link = sh(`${COMPOSE} exec -T aktenraum-api node dist/auth/setup-link-cli.js admin`);
check("CLI prints <origin>/setup/<token>", /^http:\/\/localhost:8080\/setup\/[A-Za-z0-9_-]{43}$/.test(link), link);
const adminToken = link.split("/setup/")[1];
secrets.push(adminToken);
const admin = browser(API, { ip: "198.51.100.10" });
const adminKey = new SoftAuthenticator();
const adminSetup = await register(admin, `/api/setup/${adminToken}/register`, adminKey);
check("setup link enrols and signs in", adminSetup.finish?.status === 200, JSON.stringify(adminSetup.finish?.body));
secrets.push(...(adminSetup.finish?.body?.recovery_codes ?? []));
check("admin session is a full 'setup' session", (await admin.call("GET", "/api/auth/me")).body?.auth_method === "setup");
check("the link is used up", (await browser(API).call("GET", `/api/setup/${adminToken}`)).status === 404);

console.log("2. password member → restricted → enrol → password retired");
const hash = sh(
  `${COMPOSE} exec -T aktenraum-api node -e "import('bcryptjs').then(b => b.default.hash('${MEMBER_PASSWORD}', 4)).then(h => process.stdout.write(h))"`,
);
psql(`INSERT INTO users (username, password_hash) VALUES ('${MEMBER}', '${hash}')`);
const member = browser(API, { ip: "198.51.100.20" });
const pwLogin = await member.call("POST", "/api/auth/login", { username: MEMBER, password: MEMBER_PASSWORD });
check("password login → 200 with enrolment_required", pwLogin.status === 200 && pwLogin.body?.enrolment_required === true, JSON.stringify(pwLogin.body));
const restricted = await member.call("GET", "/api/library/");
check("library refused: 403 enrolment_required", restricted.status === 403 && restricted.body?.detail === "enrolment_required");
const memberKey = new SoftAuthenticator();
const enrol = await register(member, "/api/auth/passkeys/register", memberKey);
const codes = enrol.finish?.body?.recovery_codes ?? [];
secrets.push(...codes);
check("enrolment answers 10 recovery codes", codes.length === 10, JSON.stringify(enrol.finish?.body));
check("library reachable afterwards", (await member.call("GET", "/api/library/")).status !== 403);
const pwAgain = await browser(API, { ip: "198.51.100.21" }).call("POST", "/api/auth/login", { username: MEMBER, password: MEMBER_PASSWORD });
check("the correct old password is refused (401)", pwAgain.status === 401);

console.log("3. passkey login");
const laptop = browser(API, { ip: "198.51.100.22" });
const pkLogin = await passkeyLogin(laptop, memberKey);
check("discoverable passkey login → 200", pkLogin.status === 200, JSON.stringify(pkLogin.body));
check("me: passkey session", (await laptop.call("GET", "/api/auth/me")).body?.auth_method === "passkey");

console.log("4. step-up on empty trash");
psql("UPDATE sessions SET step_up_at = now() - interval '6 minutes' WHERE auth_method = 'setup'");
const refused = await admin.call("POST", "/api/trash/empty");
check("stale confirmation → 403 step_up_required", refused.status === 403 && refused.body?.detail === "step_up_required", JSON.stringify(refused.body));
const confirmed = await stepUp(admin, adminKey);
check("step-up with the admin's passkey → 204", confirmed.status === 204, JSON.stringify(confirmed.body));
const emptied = await admin.call("POST", "/api/trash/empty");
check("empty trash then succeeds", emptied.status === 200, `${emptied.status} ${JSON.stringify(emptied.body)}`);
const foreign = await stepUp(laptop, memberKey, { credential: adminKey.credentials[0] });
check("step-up with another member's passkey → 401", foreign.status === 401 || foreign.status === 409, `${foreign.status}`);

console.log("5. recovery code → restricted → enrol");
const lost = browser(API, { ip: "198.51.100.23" });
const rec = await lost.call("POST", "/api/auth/recovery", { username: MEMBER, code: codes[0].toLowerCase() });
check("recovery code → 200 restricted", rec.status === 200 && rec.body?.enrolment_required === true, JSON.stringify(rec.body));
check("library refused before enrolment", (await lost.call("GET", "/api/library/")).status === 403);
const phoneKey = new SoftAuthenticator();
const reEnrol = await register(lost, "/api/auth/passkeys/register", phoneKey);
check("new passkey enrolled (codes kept: 9 left)", reEnrol.finish?.status === 200 && reEnrol.finish.body.recovery_codes === null);
check("full session afterwards", (await lost.call("GET", "/api/library/")).status !== 403);
const reuse = await browser(API, { ip: "198.51.100.24" }).call("POST", "/api/auth/recovery", { username: MEMBER, code: codes[0] });
check("the same code twice → 401", reuse.status === 401);

console.log("6. admin-issued setup link");
await stepUp(admin, adminKey);
const members = (await admin.call("GET", "/api/household/members")).body ?? [];
const memberId = members.find((m) => m.username === MEMBER)?.id;
const issued = await admin.call("POST", `/api/household/members/${memberId}/setup-link`);
check("admin issues a setup link (201)", issued.status === 201, `${issued.status} ${JSON.stringify(issued.body)}`);
secrets.push(issued.body?.token ?? "");
const helped = browser(API, { ip: "198.51.100.25" });
const helpedSetup = await register(helped, `/api/setup/${issued.body?.token}/register`, new SoftAuthenticator());
check("member enrols with it → new codes", helpedSetup.finish?.status === 200 && helpedSetup.finish.body.recovery_codes?.length === 10);
secrets.push(...(helpedSetup.finish?.body?.recovery_codes ?? []));
const oldCode = await browser(API, { ip: "198.51.100.26" }).call("POST", "/api/auth/recovery", { username: MEMBER, code: codes[1] });
check("old recovery codes are dead", oldCode.status === 401);

console.log("7. invite with a passkey");
const invite = await admin.call("POST", "/api/household/invites");
check("admin creates an invite", invite.status === 201, `${invite.status}`);
secrets.push(invite.body?.token ?? "");
const invitee = browser(API, { ip: "198.51.100.27" });
const joined = await register(invitee, `/api/invites/${invite.body?.token}/register`, new SoftAuthenticator(), { username: `inv-${RUN}` });
check("invitee joins with a passkey", joined.finish?.status === 200 && joined.finish.body.recovery_codes?.length === 10, JSON.stringify(joined.finish?.body));
secrets.push(...(joined.finish?.body?.recovery_codes ?? []));
check("invitee is signed in", (await invitee.call("GET", "/api/auth/me")).body?.auth_method === "invite");
check("invitee has no password", psql(`SELECT password_hash FROM users WHERE username = 'inv-${RUN}'`) === "!");

console.log("8. 10 failed passkey logins → 429, survives a restart");
const attacker = browser(API, { ip: `203.0.113.${(Date.now() % 200) + 20}` });
for (let i = 0; i < 10; i += 1) await passkeyLogin(attacker, memberKey, { badSignature: true });
const throttled = await attacker.call("POST", "/api/auth/passkeys/login/begin", {});
check("11th attempt → 429 with Retry-After", throttled.status === 429 && Number(throttled.headers.get("retry-after")) > 0);
sh(`${COMPOSE} restart aktenraum-api`);
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`${API}/api/health`)).ok) break;
  } catch {
    // starting
  }
  await sleep(2000);
}
check("still 429 after an api restart", (await attacker.call("POST", "/api/auth/passkeys/login/begin", {})).status === 429);

console.log("9. audit rows, free of secrets");
const credentialEvents = psql("SELECT DISTINCT event FROM credential_audit ORDER BY 1").split("\n");
for (const event of ["passkey_added", "recovery_codes_generated", "recovery_code_used", "setup_link_created", "setup_link_used", "password_retired", "step_up_succeeded", "step_up_failed"]) {
  check(`credential_audit has ${event}`, credentialEvents.includes(event), credentialEvents.join(","));
}
check("host-issued link audited with actor NULL", psql("SELECT count(*) FROM credential_audit WHERE event = 'setup_link_created' AND actor_member_id IS NULL") !== "0");
const authEvents = psql("SELECT DISTINCT event || ':' || coalesce(reason, '') FROM auth_audit").split("\n");
check("auth_audit has passkey logins", authEvents.includes("login_succeeded:passkey") && authEvents.includes("login_failed:passkey"), authEvents.join(","));
const dump = psql("SELECT row_to_json(a)::text FROM credential_audit a") + psql("SELECT row_to_json(a)::text FROM auth_audit a");
const normalised = (s) => s.toUpperCase().replace(/[\s-]/g, "");
check("no recovery code or link token in either audit table", secrets.filter(Boolean).every((s) => !dump.includes(s) && !dump.toUpperCase().includes(normalised(s))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
