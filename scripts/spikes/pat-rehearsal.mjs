// Personal access tokens rehearsal (personal-access-tokens, ADR-010 step 6)
// against the THROWAWAY e2e stack (project aktenraum-e2e). Run after
// `bash scripts/e2e-worker.sh` (stack up, api built from this tree, Ollama
// with the extraction model on the host). Port 8102 (api) — never the live
// stack.
//
// Covers: a stepped-up session (host-CLI setup link via e2e-session.mjs)
// creates a token with `upload` + `documents:read`; the token says who it is,
// uploads a document that the worker then extracts, lists the library; it is
// refused with 403 session_required on POST /trash/empty, GET /auth/tokens and
// the live stream, and with 403 on a scope it lacks; the list never shows the
// value; revoking it from the session makes it 401, also next to a cookie.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = process.env.E2E_API ?? "http://127.0.0.1:8102";
if (/:(8000|8002|8080)\b/.test(API)) {
  console.error(`Refusing to run: ${API} is a live-stack port.`);
  process.exit(2);
}
const ORIGIN = "http://localhost:8080";
const RUN = Date.now().toString(36);

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

async function call(method, path, { cookie, token, body, form } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = `aktenraum_session=${cookie}`;
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(API + path, { method, headers, body: payload });
  const text = await res.text();
  let json = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, headers: res.headers };
}
const detailOf = (r) => `→ ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

console.log(`PAT rehearsal against ${API} (run ${RUN})`);

// --- a stepped-up browser session ------------------------------------------
const sessionScript = fileURLToPath(new URL("./e2e-session.mjs", import.meta.url));
const cookie = execSync(`node "${sessionScript}"`, { encoding: "utf8", env: { ...process.env, E2E_API: API } }).trim();
check("stepped-up session from a setup link", cookie.length > 20);

// --- create -------------------------------------------------------------------
const created = await call("POST", "/api/auth/tokens", {
  cookie,
  body: { name: `rehearsal-${RUN}`, scopes: ["upload", "documents:read"], expires_in_days: 1 },
});
const value = created.body?.value;
check("POST /auth/tokens → 201 with an akt_pat_ value", created.status === 201 && /^akt_pat_[A-Za-z0-9_-]{43}$/.test(value ?? ""), detailOf(created));
const tokenId = created.body?.token?.id;

const listed = await call("GET", "/api/auth/tokens", { cookie });
check(
  "the list shows it without the value",
  listed.status === 200 && listed.body.some((t) => t.id === tokenId && t.state === "active") && !JSON.stringify(listed.body).includes(value),
  detailOf(listed),
);

// --- use ----------------------------------------------------------------------
const me = await call("GET", "/api/auth/me", { token: value });
check("GET /auth/me with the token → auth_method token", me.status === 200 && me.body?.auth_method === "token" && me.body?.token_name === `rehearsal-${RUN}`, detailOf(me));

const invoice = [
  "Stadtwerke Musterstadt GmbH",
  "Energieweg 12, 12345 Musterstadt",
  "",
  "RECHNUNG",
  "",
  `Rechnungsnummer: RE-PAT-${RUN}`,
  "Kundennummer: KD-4711",
  "Rechnungsdatum: 15.03.2026",
  "Gesamtbetrag brutto: 112,40 EUR",
  "",
].join("\n");
const form = new FormData();
form.append("files", new Blob([invoice], { type: "text/plain" }), `rechnung-pat-${RUN}.txt`);
const upload = await call("POST", "/api/documents/upload", { token: value, form });
const taskId = upload.body?.results?.[0]?.task_id;
check("upload with the token → 200 + a Paperless task", upload.status === 200 && typeof taskId === "string" && taskId.length > 0, detailOf(upload));

let docId = null;
for (let i = 0; i < 60 && docId === null && taskId; i++) {
  const task = await call("GET", `/api/documents/task/${taskId}`, { token: value });
  if (task.status === 200 && task.body?.doc_id) docId = task.body.doc_id;
  else if (task.body?.status === "FAILURE") break;
  else await sleep(2000);
}
check("Paperless consumed it (task → doc id, read with the token)", docId !== null, `task=${taskId}`);

let lifecycle = [];
for (let i = 0; i < 100 && docId !== null && lifecycle.length === 0; i++) {
  const status = await call("GET", `/api/documents/${docId}/status`, { token: value });
  lifecycle = status.body?.lifecycle_tags ?? [];
  if (lifecycle.length === 0) await sleep(3000);
}
check(
  "the worker extracted it (a lifecycle tag appeared)",
  lifecycle.some((t) => ["ai-pending", "ai-approved", "ai-propagated"].includes(t)),
  `doc=${docId} tags=${JSON.stringify(lifecycle)}`,
);

const library = await call("GET", "/api/library/?page_size=100&ordering=-created", { token: value });
check("GET /library with the token → 200", library.status === 200 && Array.isArray(library.body?.results), detailOf(library));

// --- refused --------------------------------------------------------------------
for (const [method, path] of [
  ["POST", "/api/trash/empty"],
  ["GET", "/api/auth/tokens"],
  ["POST", "/api/auth/tokens"],
  ["GET", "/api/events/counts"],
  ["GET", "/api/auth/sessions"],
]) {
  const r = await call(method, path, { token: value, body: method === "POST" ? {} : undefined });
  check(`${method} ${path} with the token → 403 session_required`, r.status === 403 && r.body?.detail === "session_required", detailOf(r));
}
if (docId !== null) {
  const del = await call("DELETE", `/api/documents/${docId}`, { token: value });
  check("DELETE a document without documents:delete → 403 Insufficient scope", del.status === 403 && del.body?.detail === "Insufficient scope", detailOf(del));
}
const internal = await call("GET", "/api/settings/active-llm-model", { token: value });
check("worker-only route with the token → 401", internal.status === 401, detailOf(internal));

// --- revoke -------------------------------------------------------------------
const revoke = await call("DELETE", `/api/auth/tokens/${tokenId}`, { cookie });
check("DELETE /auth/tokens/:id from the session (no new step-up) → 204", revoke.status === 204, detailOf(revoke));
const after = await call("GET", "/api/library/", { token: value });
check("the revoked token → 401 Invalid token", after.status === 401 && after.body?.detail === "Invalid token", detailOf(after));
const withCookie = await call("GET", "/api/library/", { token: value, cookie });
check("revoked token + valid cookie → still 401", withCookie.status === 401, detailOf(withCookie));
const cookieOnly = await call("GET", "/api/library/", { cookie });
check("the cookie alone still works", cookieOnly.status === 200, detailOf(cookieOnly));
const relisted = await call("GET", "/api/auth/tokens", { cookie });
check("the list shows it revoked", relisted.body?.some?.((t) => t.id === tokenId && t.state === "revoked"), detailOf(relisted));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
