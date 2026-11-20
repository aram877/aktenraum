// Share rehearsal against the THROWAWAY e2e stack (project aktenraum-e2e).
// Run after `bash scripts/e2e-worker.sh` (needs its documents). The e2e api has
// QDRANT_URL empty, so the shared_with check fails there by design — verify
// it on a stack whose api has Qdrant.
// Ports 8100 (Paperless), 8102 (api), 6433 (Qdrant) — never the live stack.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = "http://127.0.0.1:8102";
const PAPERLESS = "http://127.0.0.1:8100";
const QDRANT = "http://127.0.0.1:6433";
const PL_AUTH = "Basic " + Buffer.from("admin:e2epassword").toString("base64");
const COMPOSE = `docker compose -f "${fileURLToPath(new URL("../../docker/docker-compose.e2e.yml", import.meta.url))}"`;

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

function agent() {
  const jar = new Map();
  async function call(method, path, body) {
    const headers = { "content-type": "application/json" };
    if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  return { call };
}

async function paperless(method, path, body) {
  const res = await fetch(PAPERLESS + path, {
    method,
    headers: { authorization: PL_AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

async function permsOf(docId) {
  return paperless("GET", `/api/documents/${docId}/?full_perms=true`);
}

async function sharedWith(docId) {
  const res = await fetch(`${QDRANT}/collections/aktenraum_chunks/points/scroll`, {
    method: "POST",
    headers: { "api-key": "e2e-qdrant-key", "content-type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "doc_id", match: { value: docId } }] }, limit: 1, with_payload: true }),
  });
  const point = (await res.json()).result?.points?.[0];
  return point ? point.payload.shared_with : null;
}

function psql(sql) {
  return execSync(`${COMPOSE} exec -T postgres psql -U paperless -d aktenraum -tA -c "${sql}"`, { encoding: "utf8" }).trim();
}

async function ask(a, question) {
  const res = await a.call("POST", "/api/ai/answer/stream", { question });
  const text = typeof res.body === "string" ? res.body : "";
  const final = text.split("\n\n").find((b) => b.startsWith("event: final"));
  if (!final) return { ids: [], raw: text.slice(0, 300) };
  const data = JSON.parse(/^data: (.+)$/m.exec(final)[1]);
  return { ids: data.citations.map((c) => c.id), raw: "" };
}

const admin = agent();
const bob = agent();

console.log("\n==> setup");
check("admin login", (await admin.call("POST", "/api/auth/login", { username: "admin", password: "e2epassword" })).status === 200);
const invite = await admin.call("POST", "/api/household/invites");
check("invite created", invite.status === 201, JSON.stringify(invite.body));
const redeem = await bob.call("POST", `/api/invites/${invite.body.token}/redeem`, { username: "bob", password: "bob-password-123" });
check("bob redeemed the invite", redeem.status === 200, JSON.stringify(redeem.body));
const directory = (await admin.call("GET", "/api/household/directory")).body;
const bobId = directory.find((m) => m.username === "bob").id;
const library = (await admin.call("GET", "/api/library/")).body.results;
const docIds = library.map((r) => r.id).sort((x, y) => x - y);
check("admin has documents", docIds.length >= 1, JSON.stringify(docIds));
const doc = docIds[0];
const bobPaperlessId = Number(psql(`SELECT paperless_user_id FROM members WHERE id = ${bobId}`));
console.log(`  doc=${doc} bob member=${bobId} paperless user=${bobPaperlessId}`);

console.log("\n==> before sharing");
check("bob gets 404 on the document", (await bob.call("GET", `/api/documents/${doc}/detail`)).status === 404);
const askQuestion = "Was steht in der Rechnung und wie hoch ist der Betrag?";
const askBefore = await ask(bob, askQuestion);
check("Ask does not cite it for bob", !askBefore.ids.includes(doc), JSON.stringify(askBefore));

console.log("\n==> viewer share");
const grant = await admin.call("POST", `/api/documents/${doc}/shares`, { member_id: bobId, role: "viewer" });
check("grant viewer → 201", grant.status === 201, JSON.stringify(grant.body));
const detail = await bob.call("GET", `/api/documents/${doc}/detail`);
check("bob reads it through his own token", detail.status === 200);
check("access = share/viewer", detail.body?.access?.via === "share" && detail.body.access.role === "viewer", JSON.stringify(detail.body?.access));
check("shared_by = admin, no home space", detail.body?.shared_by?.username === "admin" && detail.body.home_space === null);
check("bob downloads it", (await bob.call("GET", `/api/documents/${doc}/download`)).status === 200);
check("bob can't edit fields (viewer)", (await bob.call("PATCH", `/api/documents/${doc}/fields`, { ai_title: "x" })).status === 404);
let perms = await permsOf(doc);
check("Paperless view.users has bob", perms.permissions.view.users.includes(bobPaperlessId), JSON.stringify(perms.permissions));
check("Paperless change.users has not", !perms.permissions.change.users.includes(bobPaperlessId));
check("Qdrant shared_with = [bob]", JSON.stringify(await sharedWith(doc)) === JSON.stringify([bobId]), JSON.stringify(await sharedWith(doc)));
const bobLib = (await bob.call("GET", "/api/library/")).body.results;
const row = bobLib.find((r) => r.id === doc);
check("bob's library lists it with shared_by", row?.shared_by?.username === "admin" && row.home_space === null);
const askAfter = await ask(bob, askQuestion);
check("Ask cites it for bob now", askAfter.ids.includes(doc), JSON.stringify(askAfter));

console.log("\n==> editor share");
check("upgrade to editor", (await admin.call("PATCH", `/api/documents/${doc}/shares/${bobId}`, { role: "editor" })).status === 200);
check("bob edits a field", (await bob.call("PATCH", `/api/documents/${doc}/fields`, { ai_reference_numbers: "RE-BOB" })).status === 200);
perms = await permsOf(doc);
check("Paperless change.users has bob", perms.permissions.change.users.includes(bobPaperlessId));
check("bob can't approve", (await bob.call("POST", `/api/inbox/${doc}/approve`, {})).status === 404);
check("bob can't reprocess", (await bob.call("POST", `/api/documents/${doc}/reprocess`)).status === 404);
check("bob can't delete", (await bob.call("DELETE", `/api/documents/${doc}`)).status === 404);
check("bob can't re-share", (await bob.call("POST", `/api/documents/${doc}/shares`, { member_id: 1, role: "viewer" })).status === 404);
check("bob can't read the audit log", (await bob.call("GET", `/api/documents/${doc}/shares/audit`)).status === 404);

console.log("\n==> inbox absence");
const pendingTag = (await paperless("GET", "/api/tags/?name__iexact=ai-pending")).results[0].id;
await paperless("PATCH", `/api/documents/${doc}/`, { tags: [pendingTag] });
const bobInbox = (await bob.call("GET", "/api/inbox/")).body.results.map((r) => r.id);
const adminInbox = (await admin.call("GET", "/api/inbox/")).body.results.map((r) => r.id);
check("pending shared doc not in bob's inbox", !bobInbox.includes(doc), JSON.stringify(bobInbox));
check("…but in admin's inbox", adminInbox.includes(doc), JSON.stringify(adminInbox));

console.log("\n==> revoke");
check("revoke → 204", (await admin.call("DELETE", `/api/documents/${doc}/shares/${bobId}`)).status === 204);
check("bob gets 404 again", (await bob.call("GET", `/api/documents/${doc}/detail`)).status === 404);
perms = await permsOf(doc);
check("Paperless no longer grants bob", !perms.permissions.view.users.includes(bobPaperlessId) && !perms.permissions.change.users.includes(bobPaperlessId));
check("Qdrant shared_with = []", JSON.stringify(await sharedWith(doc)) === "[]");

console.log("\n==> expiry");
check(
  "grant with expiry",
  (await admin.call("POST", `/api/documents/${doc}/shares`, { member_id: bobId, role: "viewer", expires_at: "2099-12-31T22:59:59Z" })).status === 201,
);
check("bob reads it", (await bob.call("GET", `/api/documents/${doc}/detail`)).status === 200);
psql(`UPDATE document_shares SET expires_at = now() - interval '1 minute' WHERE paperless_doc_id = ${doc} AND member_id = ${bobId}`);
check("expired → bob gets 404 at once", (await bob.call("GET", `/api/documents/${doc}/detail`)).status === 404);
await bob.call("GET", "/api/library/");
check("sweep removed the row", psql(`SELECT count(*) FROM document_shares WHERE paperless_doc_id = ${doc}`) === "0");
perms = await permsOf(doc);
check("Paperless no longer grants bob after expiry", !perms.permissions.view.users.includes(bobPaperlessId));
check("Qdrant shared_with = [] after expiry", JSON.stringify(await sharedWith(doc)) === "[]");

console.log("\n==> audit");
const audit = (await admin.call("GET", `/api/documents/${doc}/shares/audit`)).body;
const events = new Set(audit.map((e) => (e.event === "accessed" ? `accessed:${e.access_kind}` : e.event)));
for (const e of ["granted", "role_changed", "revoked", "expired", "accessed:detail", "accessed:download", "accessed:ask"]) {
  check(`audit has ${e}`, events.has(e), JSON.stringify([...events]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
