// Server-side sessions rehearsal (auth-server-sessions) against the THROWAWAY
// e2e stack (project aktenraum-e2e). Run after `bash scripts/e2e-worker.sh`
// (stack up, api built from this tree). Port 8102 (api) — never the live stack.
//
// The e2e api has no nginx in front, so this script sends X-Forwarded-For
// itself to play two browsers on different machines (the api trusts one hop).
//
// Covers: two devices in the device list with distinct addresses → revoke the
// other → 401; logout replay → 401; the enrolled admin's password refused;
// open live stream + revoke → session_ended; 11 failed logins → 429, api
// restart → still 429; an old JWT-shaped cookie → 401; auth_audit rows written.
//
// auth-passkeys: devices sign in with the admin's passkey (software
// authenticator), enrolled first through a host-CLI setup link.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ORIGIN, SoftAuthenticator, browser as passkeyBrowser, register } from "./soft-authenticator.mjs";

const API = "http://127.0.0.1:8102";
const COMPOSE = `docker compose -f "${fileURLToPath(new URL("../../docker/docker-compose.e2e.yml", import.meta.url))}"`;
const RUN = Date.now().toString(36);
const ADMIN = "admin";
const PASSWORD = "e2epassword";
const adminKey = new SoftAuthenticator();

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

/** A browser: own cookie jar, address and user agent. */
function browser(ip, userAgent) {
  const jar = new Map();
  const remember = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
  };
  const headers = () => ({
    "content-type": "application/json",
    origin: ORIGIN,
    "x-forwarded-for": ip,
    "user-agent": userAgent,
    ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
  });
  async function call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    remember(res);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  return {
    jar,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    del: (p) => call("DELETE", p),
    passwordLogin: (username = ADMIN, password = PASSWORD) => call("POST", "/api/auth/login", { username, password }),
    /** Discoverable sign-in with the admin's passkey. */
    login: async () => {
      const begin = await call("POST", "/api/auth/passkeys/login/begin", {});
      if (begin.status !== 200) return begin;
      return call("POST", "/api/auth/passkeys/login/finish", {
        ceremony: begin.body.ceremony,
        response: adminKey.authenticate(begin.body.options),
      });
    },
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    headers,
  };
}

async function rawMe(cookie) {
  const res = await fetch(`${API}/api/auth/me`, { headers: { cookie } });
  return res.status;
}

async function waitForApi() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${API}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  throw new Error("api did not come back");
}

function psql(query) {
  return execSync(`${COMPOSE} exec -T postgres psql -U paperless -d aktenraum -At -c "${query}"`, {
    encoding: "utf8",
  }).trim();
}

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

await waitForApi();

console.log("0. Admin passkey via a host-CLI setup link");
const link = execSync(`${COMPOSE} exec -T aktenraum-api node dist/auth/setup-link-cli.js ${ADMIN}`, {
  encoding: "utf8",
  env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  stdio: ["ignore", "pipe", "ignore"],
}).trim();
const setup = await register(passkeyBrowser(API), `/api/setup/${link.split("/setup/")[1]}/register`, adminKey);
check("admin enrolled a passkey", setup.finish?.status === 200, JSON.stringify(setup.finish?.body));

console.log("1. Old JWT-shaped cookie");
const jwtShaped =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwicHdmIjoiYWJjIiwiaWF0IjoxLCJleHAiOjk5OTk5OTk5OTl9.c2lnbmF0dXJl";
check("JWT cookie → 401", (await rawMe(`aktenraum_session=${jwtShaped}`)) === 401);

console.log("2. Two devices, device list, revoke the other");
const laptop = browser("203.0.113.7", CHROME_WIN);
const phone = browser("198.51.100.23", SAFARI_IOS);
check("laptop login 200", (await laptop.login()).status === 200);
check("phone login 200", (await phone.login()).status === 200);
const token = laptop.jar.get("aktenraum_session") ?? "";
check("cookie is an opaque 43-char token", /^[A-Za-z0-9_-]{43}$/.test(token), token);
const stored = psql(`SELECT count(*) FROM sessions WHERE token_hash = '${token}'`);
check("raw token is not stored", stored === "0", stored);
const list = (await laptop.get("/api/auth/sessions")).body;
const mine = Array.isArray(list) ? list.filter((s) => s.ip === "203.0.113.7" || s.ip === "198.51.100.23") : [];
check("device list shows both with distinct addresses", mine.length === 2, JSON.stringify(list));
const current = mine.find((s) => s.current);
check("laptop marked current", current?.ip === "203.0.113.7" && current?.user_agent === CHROME_WIN, JSON.stringify(current));
const phoneSession = mine.find((s) => !s.current);
check("revoke phone 204", (await laptop.del(`/api/auth/sessions/${phoneSession?.id}`)).status === 204);
check("phone → 401", (await phone.get("/api/auth/me")).status === 401);
check("laptop still 200", (await laptop.get("/api/auth/me")).status === 200);

console.log("3. Logout replay");
const copied = laptop.cookie();
check("logout 204", (await laptop.post("/api/auth/logout")).status === 204);
check("replayed cookie → 401", (await rawMe(copied)) === 401);

console.log("4. Open live stream + revoke → session_ended");
const viewer = browser("192.0.2.44", SAFARI_IOS);
const controller = browser("192.0.2.45", CHROME_WIN);
await viewer.login();
await controller.login();
const viewerId = (await viewer.get("/api/auth/sessions")).body.find((s) => s.current)?.id;
const abort = new AbortController();
const streamText = (async () => {
  const res = await fetch(`${API}/api/events/counts`, { headers: viewer.headers(), signal: abort.signal });
  const reader = res.body.getReader();
  let text = "";
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
})();
await sleep(1500);
const t0 = Date.now();
await controller.del(`/api/auth/sessions/${viewerId}`);
const text = await Promise.race([streamText, sleep(15_000).then(() => "TIMEOUT")]);
abort.abort();
check("stream ended with session_ended/revoked", text.includes("event: session_ended\ndata: revoked"), text.slice(-200));
check("within one poll interval (+1 s)", Date.now() - t0 < 4_500, `${Date.now() - t0} ms`);
check("reconnect → 401", (await viewer.get("/api/events/counts")).status === 401);

console.log("5. The enrolled admin's password is refused");
const retired = await browser("203.0.113.70", CHROME_WIN).passwordLogin();
check("correct password → 401 after enrolment", retired.status === 401, String(retired.status));

console.log("6. Rate limit survives a restart");
const sprayer = browser("203.0.113.99", CHROME_WIN);
const victim = `nobody-${RUN}`;
for (let i = 0; i < 10; i += 1) await sprayer.passwordLogin(victim, "wrong-password");
const eleventh = await sprayer.passwordLogin(victim, "wrong-password");
check("11th attempt → 429", eleventh.status === 429, String(eleventh.status));
check("Retry-After set", Number(eleventh.headers.get("retry-after")) > 0, eleventh.headers.get("retry-after"));
check("admin from another address unaffected", (await browser("198.51.100.200", CHROME_WIN).login()).status === 200);
execSync(`${COMPOSE} restart aktenraum-api`, { stdio: "ignore" });
await waitForApi();
const afterRestart = await browser("198.51.100.201", CHROME_WIN).passwordLogin(victim, "wrong-password");
check("after restart, username still → 429", afterRestart.status === 429, String(afterRestart.status));
const sprayAfter = await sprayer.login();
check("after restart, spraying address still → 429", sprayAfter.status === 429, String(sprayAfter.status));

console.log("7. Audit log");
const events = psql("SELECT string_agg(DISTINCT event, ',' ORDER BY event) FROM auth_audit");
for (const event of ["login_failed", "login_succeeded", "login_throttled", "logout", "session_revoked"]) {
  check(`auth_audit has ${event}`, events.split(",").includes(event), events);
}
const leaked = psql(`SELECT count(*) FROM auth_audit WHERE CONCAT_WS(' ', username, reason, ip, user_agent) LIKE '%${token}%'`);
check("no token in the audit", leaked === "0", leaked);
const ips = psql("SELECT string_agg(DISTINCT ip, ',') FROM sessions WHERE ip LIKE '203.0.113.%' OR ip LIKE '198.51.100.%'");
check("sessions carry the forwarded browser addresses", ips.includes("203.0.113.7") && ips.includes("198.51.100.23"), ips);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
