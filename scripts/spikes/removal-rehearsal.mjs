// Member-removal rehearsal against the THROWAWAY e2e stack (project aktenraum-e2e).
// Run after `bash scripts/e2e-worker.sh` (stack up, api built from this tree).
// Ports 8100 (Paperless), 8102 (api), 6433 (Qdrant) — never the live stack.
//
// Part 1: Bob (personal documents, one trashed; owns "Wohnung" with Carol as
// editor and the admin as viewer; editor in the admin's "Haushalt"; a share
// received from Carol, one granted to Carol and one to the admin) is removed
// with the admin as successor.
// Part 2: Dave is removed while Paperless is stopped → "completing", then the
// periodic sync finishes it once Paperless is back.
//
// The e2e api writes to the e2e Qdrant (RERANKER_ENABLED=false): the removal's
// own chunk-space rewrite is checked first, then the worker's startup
// chunk-space reconcile as a second line (auto-tagger restart).
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { adminMember, anonymous, joinWithPasskey } from "./rehearsal-auth.mjs";

const API = "http://127.0.0.1:8102";
const PAPERLESS = "http://127.0.0.1:8100";
const QDRANT = "http://127.0.0.1:6433";
const PL_AUTH = "Basic " + Buffer.from("admin:e2epassword").toString("base64");
const COMPOSE = `docker compose -f "${fileURLToPath(new URL("../../docker/docker-compose.e2e.yml", import.meta.url))}"`;
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

async function paperless(method, path, body, auth = PL_AUTH) {
  const res = await fetch(PAPERLESS + path, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function psql(sql) {
  return execSync(`${COMPOSE} exec -T postgres psql -U paperless -d aktenraum -tA -c "${sql}"`, { encoding: "utf8" }).trim();
}

async function until(label, fn, timeoutMs = 15 * 60_000, everyMs = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

async function chunkSpace(docId) {
  const res = await fetch(`${QDRANT}/collections/aktenraum_chunks/points/scroll`, {
    method: "POST",
    headers: { "api-key": "e2e-qdrant-key", "content-type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "doc_id", match: { value: docId } }] }, limit: 1, with_payload: true }),
  });
  const point = (await res.json()).result?.points?.[0];
  return point ? point.payload.space_id : undefined;
}

async function ask(a, question) {
  const res = await a.call("POST", "/api/ai/answer/stream", { question });
  const text = typeof res.body === "string" ? res.body : "";
  const final = text.split("\n\n").find((b) => b.startsWith("event: final"));
  if (!final) return { ids: [], raw: text.slice(0, 300) };
  const data = JSON.parse(/^data: (.+)$/m.exec(final)[1]);
  return { ids: data.citations.map((c) => c.id), raw: data.answer_de?.slice(0, 200) ?? "" };
}

function invoice(sender, no, amount) {
  return `${sender}\nHauptstrasse 1, 12345 Musterstadt\n\nRECHNUNG\n\nRechnungsnummer: ${no}\nRechnungsdatum: 10.11.2026\n\nPosition 1: Leistung    ${amount} EUR\n\nGesamtbetrag brutto: ${amount} EUR\n`;
}

/** Uploads as `who`, waits until the worker gave the document its home space; returns the doc id. */
async function uploadAndPlace(who, memberId, filename, text) {
  const res = await who.upload(filename, text);
  const taskId = res.body?.results?.[0]?.task_id;
  if (!taskId) throw new Error(`upload failed: ${JSON.stringify(res.body)}`);
  const docId = await until(`document for ${filename}`, async () => {
    const task = (await paperless("GET", `/api/tasks/?task_id=${taskId}`)).body?.[0];
    const id = task?.related_document;
    return id ? Number(id) : null;
  });
  await until(`home space of ${docId}`, async () => psql(`SELECT space_id FROM document_spaces WHERE paperless_doc_id = ${docId}`) !== "");
  const personal = psql(`SELECT id FROM spaces WHERE personal_member_id = ${memberId}`);
  const home = psql(`SELECT space_id FROM document_spaces WHERE paperless_doc_id = ${docId}`);
  if (home !== personal) throw new Error(`doc ${docId} landed in ${home}, expected ${personal}`);
  return docId;
}

async function joinHousehold(admin, username) {
  const who = await joinWithPasskey(API, admin, username);
  const id = (await admin.call("GET", "/api/household/members")).body.find((m) => m.username === username).id;
  return { who, id };
}

const pid = (memberId) => Number(psql(`SELECT paperless_user_id FROM members WHERE id = ${memberId}`));

// ====================================================================== part 1
console.log("\n==> setup");
const admin = await adminMember(API, COMPOSE);
check("admin signed in with a passkey (setup link)", Boolean(admin.cookie()));
const adminId = (await admin.call("GET", "/api/household/members")).body.find((m) => m.username === "admin").id;
const bobName = `bob${RUN}`;
const carolName = `carol${RUN}`;
const { who: bob, id: bobId } = await joinHousehold(admin, bobName);
const { who: carol, id: carolId } = await joinHousehold(admin, carolName);
console.log(`  admin=${adminId} bob=${bobId} carol=${carolId}`);

console.log("  uploading (waits for the worker to place each document)…");
const d1 = await uploadAndPlace(bob, bobId, `b1-${RUN}.txt`, invoice(`Wasserwerke Removalstadt ${RUN}`, `WR-${RUN}-1`, "77,40"));
const d2 = await uploadAndPlace(bob, bobId, `b2-${RUN}.txt`, invoice(`Gaswerk Bobhausen ${RUN}`, `GB-${RUN}-2`, "12,00"));
const d3 = await uploadAndPlace(bob, bobId, `b3-${RUN}.txt`, invoice(`Papierkorb GmbH ${RUN}`, `PK-${RUN}-3`, "5,00"));
const d4 = await uploadAndPlace(bob, bobId, `b4-${RUN}.txt`, invoice(`Hausverwaltung Wohnung ${RUN}`, `HW-${RUN}-4`, "800,00"));
const d5 = await uploadAndPlace(carol, carolId, `c5-${RUN}.txt`, invoice(`Carols Versicherung ${RUN}`, `CV-${RUN}-5`, "33,00"));
console.log(`  docs: bob ${d1},${d2},${d3},${d4} carol ${d5}`);

const wohnung = (await bob.call("POST", "/api/spaces", { name: `Wohnung ${RUN}` })).body.id;
check("Wohnung: carol editor", (await bob.call("POST", `/api/spaces/${wohnung}/members`, { member_id: carolId, role: "editor" })).status === 201);
check("Wohnung: admin viewer", (await bob.call("POST", `/api/spaces/${wohnung}/members`, { member_id: adminId, role: "viewer" })).status === 201);
check("d4 moved into Wohnung", (await bob.call("POST", `/api/documents/${d4}/move`, { space_id: wohnung })).status === 200);
const haushalt = (await admin.call("POST", "/api/spaces", { name: `Haushalt ${RUN}` })).body.id;
check("Haushalt: bob editor", (await admin.call("POST", `/api/spaces/${haushalt}/members`, { member_id: bobId, role: "editor" })).status === 201);
check("share carol → bob (d5)", (await carol.call("POST", `/api/documents/${d5}/shares`, { member_id: bobId, role: "viewer" })).status === 201);
check("share bob → carol (d1)", (await bob.call("POST", `/api/documents/${d1}/shares`, { member_id: carolId, role: "viewer" })).status === 201);
check("share bob → admin (d2)", (await bob.call("POST", `/api/documents/${d2}/shares`, { member_id: adminId, role: "editor" })).status === 201);

// Let the worker finish extracting Bob's documents, then approve d1 so it gets indexed.
console.log("  waiting for extraction of bob's documents…");
const tagsOf = async (d) => (await bob.call("GET", `/api/documents/${d}/status`)).body?.lifecycle_tags ?? [];
await until("extraction", async () => {
  for (const d of [d1, d2, d3, d4]) if ((await tagsOf(d)).length === 0) return false;
  return true;
});
// The worker e2e enables auto-approve for Rechnung, so d1 may already be on its way.
if ((await tagsOf(d1)).includes("ai-pending")) {
  check("bob approves d1", (await bob.call("POST", `/api/inbox/${d1}/approve`, {})).status === 200);
}
console.log("  waiting for d1 to be indexed…");
await until("d1 chunks", async () => (await chunkSpace(d1)) !== undefined);
check("d1 chunks carry bob's personal space", String(await chunkSpace(d1)) === psql(`SELECT id FROM spaces WHERE personal_member_id = ${bobId}`));
check("bob trashes d3", (await bob.call("DELETE", `/api/documents/${d3}`)).status === 204);

// A Paperless token for Bob's user, to show it dies with the removal.
const bobPl = pid(bobId);
await paperless("PATCH", `/api/users/${bobPl}/`, { password: `pl-${RUN}-secret` });
const tokenRes = await fetch(`${PAPERLESS}/api/token/`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: `ak-${bobId}`, password: `pl-${RUN}-secret` }),
});
const bobToken = (await tokenRes.json()).token;
check("bob's Paperless token works before", (await paperless("GET", "/api/documents/?page_size=1", undefined, `Token ${bobToken}`)).status === 200);

console.log("\n==> preview");
const preview = (await admin.call("GET", `/api/household/members/${bobId}/removal-preview`)).body;
console.log("  " + JSON.stringify(preview));
check("preview: 3 documents, 1 trashed", preview.documents === 3 && preview.trashed === 1);
check("preview: owns Wohnung, leaves Haushalt", preview.spaces_owned?.[0]?.id === wohnung && preview.spaces_left?.[0]?.id === haushalt);
check("preview: 2 shares end, 1 kept", preview.shares_revoked === 2 && preview.shares_kept === 1);

console.log("\n==> remove bob (successor: admin)");
const wrong = await admin.call("POST", `/api/household/members/${bobId}/remove`, { confirm_username: "nope" });
check("wrong confirmation → 422", wrong.status === 422);
const removed = await admin.call("POST", `/api/household/members/${bobId}/remove`, { confirm_username: bobName });
check("removal → 200 done", removed.status === 200 && removed.body.status === "done", JSON.stringify(removed.body));

console.log("\n==> lockout");
check("bob's session → 401", (await bob.call("GET", "/api/auth/me")).status === 401);
const bobLogin = await anonymous(API).call("POST", "/api/auth/login", { username: bobName, password: `${bobName}-password-123` });
const badLogin = await anonymous(API).call("POST", "/api/auth/login", { username: carolName, password: "wrong-password-1" });
check("bob's login answers like a wrong password", bobLogin.status === 401 && JSON.stringify(bobLogin.body) === JSON.stringify(badLogin.body));
check("bob's Paperless token → 401", (await paperless("GET", "/api/documents/?page_size=1", undefined, `Token ${bobToken}`)).status === 401);
const bobUser = (await paperless("GET", `/api/users/${bobPl}/`)).body;
check("bob's Paperless user inactive, no groups", bobUser.is_active === false && bobUser.groups.length === 0, JSON.stringify(bobUser));
const members = (await admin.call("GET", "/api/household/members")).body.map((m) => m.username);
check("bob gone from the member list", !members.includes(bobName));

console.log("\n==> hand-over");
const adminPl = pid(adminId);
const adminPersonal = psql(`SELECT id FROM spaces WHERE personal_member_id = ${adminId}`);
for (const [label, d] of [["d1", d1], ["d2", d2]]) {
  check(`${label}: home = admin personal`, psql(`SELECT space_id FROM document_spaces WHERE paperless_doc_id = ${d}`) === adminPersonal);
  check(`${label}: Paperless owner = admin`, (await paperless("GET", `/api/documents/${d}/?full_perms=true`)).body.owner === adminPl);
}
const d4Perms = (await paperless("GET", `/api/documents/${d4}/?full_perms=true`)).body;
check("d4 stays in Wohnung, owned by admin in Paperless", psql(`SELECT space_id FROM document_spaces WHERE paperless_doc_id = ${d4}`) === String(wohnung) && d4Perms.owner === adminPl);
check("Wohnung: admin owner, carol editor", psql(`SELECT string_agg(member_id || ':' || role, ',' ORDER BY member_id) FROM space_members WHERE space_id = ${wohnung}`) === `${adminId}:owner,${carolId}:editor`);
check("Haushalt: bob gone", psql(`SELECT count(*) FROM space_members WHERE space_id = ${haushalt} AND member_id = ${bobId}`) === "0");
check("admin edits a Wohnung document now", (await admin.call("PATCH", `/api/documents/${d4}/fields`, { ai_reference_numbers: "OWNER" })).status === 200);
check("carol keeps bob's share of d1", (await carol.call("GET", `/api/documents/${d1}/detail`)).status === 200);
const d1Shares = (await admin.call("GET", `/api/documents/${d1}/shares`)).body;
check("admin sees and manages the share of d1", Array.isArray(d1Shares) && d1Shares[0]?.username === carolName);
check("share to admin (d2) ended", psql(`SELECT count(*) FROM document_shares WHERE paperless_doc_id = ${d2}`) === "0");
check("share carol → bob (d5) revoked", psql(`SELECT count(*) FROM document_shares WHERE paperless_doc_id = ${d5}`) === "0");
check("audit: both revoked by admin", psql(`SELECT count(*) FROM share_audit WHERE event = 'revoked' AND actor_member_id = ${adminId} AND paperless_doc_id IN (${d2}, ${d5})`) === "2");
check("carol's 'Von mir geteilt' is empty", JSON.stringify((await carol.call("GET", "/api/shares/by-me")).body) === "[]");
const d5Perms = (await paperless("GET", `/api/documents/${d5}/?full_perms=true`)).body;
check("d5: bob's user no longer in view.users", !d5Perms.permissions.view.users.includes(bobPl));

console.log("\n==> trashed document");
const trash = (await admin.call("GET", "/api/trash")).body.results?.map((r) => r.id) ?? [];
check("d3 is in the admin's trash", trash.includes(d3), JSON.stringify(trash));
check("admin restores d3", (await admin.call("POST", `/api/trash/${d3}/restore`)).status === 204);
check("admin opens d3", (await admin.call("GET", `/api/documents/${d3}/detail`)).status === 200);
check("d3 home = admin personal", psql(`SELECT space_id FROM document_spaces WHERE paperless_doc_id = ${d3}`) === adminPersonal);

console.log("\n==> Ask + Qdrant");
// No run suffix: the extraction drops it from the correspondent, and the filter LLM would search for it.
const answer = await ask(admin, "Wie hoch ist die Rechnung der Wasserwerke Removalstadt?");
check("Ask cites former bob document d1 for admin", answer.ids.includes(d1), JSON.stringify(answer));
const byApi = await until("api chunk space rewrite", async () => String(await chunkSpace(d1)) === adminPersonal, 30_000, 2_000).catch(() => false);
check("removal itself sets d1's chunk space to admin personal (api → Qdrant)", byApi === true, `space=${await chunkSpace(d1)}`);
execSync(`${COMPOSE} restart auto-tagger`, { stdio: "ignore" });
const fixed = await until("chunk space reconcile", async () => String(await chunkSpace(d1)) === adminPersonal, 5 * 60_000).catch(() => false);
check("worker reconcile sets d1's chunk space to admin personal", fixed === true, `space=${await chunkSpace(d1)}`);

const list = (await admin.call("GET", "/api/household/removals")).body;
check("removals list: bob done", list.find((r) => r.username === bobName)?.status === "done");

// ====================================================================== part 2
console.log("\n==> part 2: Paperless down mid-removal");
const daveName = `dave${RUN}`;
const { who: dave, id: daveId } = await joinHousehold(admin, daveName);
const d6 = await uploadAndPlace(dave, daveId, `d6-${RUN}.txt`, invoice(`Daves Stadtwerke ${RUN}`, `DS-${RUN}-6`, "9,99"));
console.log(`  dave=${daveId} doc=${d6}`);
execSync(`${COMPOSE} stop paperless`, { stdio: "ignore" });
const r2 = await admin.call("POST", `/api/household/members/${daveId}/remove`, { confirm_username: daveName });
check("removal with Paperless down → 200 completing", r2.status === 200 && r2.body.status === "completing", JSON.stringify(r2.body));
check("dave locked out at once", (await dave.call("GET", "/api/auth/me")).status === 401);
check("d6 already belongs to admin in the database", psql(`SELECT space_id FROM document_spaces WHERE paperless_doc_id = ${d6}`) === adminPersonal);
const pending = (await admin.call("GET", "/api/household/removals")).body.find((r) => r.username === daveName);
check("removals list: completing with an error", pending?.status === "completing" && Boolean(pending.last_error), JSON.stringify(pending));
execSync(`${COMPOSE} start paperless`, { stdio: "ignore" });
await until("paperless back", async () => (await paperless("GET", "/api/").catch(() => ({ status: 0 }))).status === 200, 5 * 60_000);
console.log("  Paperless is back; waiting for the 5-minute removal sync…");
const t0 = Date.now();
const done = await until(
  "sync",
  async () => (await admin.call("GET", "/api/household/removals")).body.find((r) => r.username === daveName)?.status === "done",
  7 * 60_000,
  15_000,
).catch(() => false);
check(`sync completed dave's removal (${Math.round((Date.now() - t0) / 1000)} s)`, done === true);
const davePl = (await paperless("GET", `/api/users/${pid(daveId)}/`)).body;
check("dave's Paperless user inactive", davePl.is_active === false);
check("d6 Paperless owner = admin", (await paperless("GET", `/api/documents/${d6}/?full_perms=true`)).body.owner === adminPl);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
