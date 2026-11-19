// Follow-up: metadata ownership + counts + tasks. e2e Paperless only.
const BASE = "http://127.0.0.1:8100";
async function tok(u, p) {
  const r = await fetch(`${BASE}/api/token/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });
  return (await r.json()).token;
}
async function api(t, m, path, body) {
  const h = { Authorization: `Token ${t}` };
  if (body) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + path, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const ADMIN = await tok("admin", "e2epassword");
const ALICE = await tok("alice", "alice-pw-123");
const BOB = await tok("bob", "bob-pw-123");

const find = async (kind, name) => (await api(ADMIN, "GET", `/api/${kind}/?name__iexact=${encodeURIComponent(name)}`)).json.results[0];
const tag = await find("tags", "ai-propagated-spike");
const secret = await find("tags", "geheim-alice-only");
const dt = await find("document_types", "Gehaltsabrechnung-spike");
const co = await find("correspondents", "Arbeitgeber GmbH spike");

// What does bob see on a doc he CAN read when its tag/type/correspondent are invisible to him?
let r = await api(BOB, "GET", `/api/documents/2/`);
console.log("bob doc H raw fields (metadata admin-owned):", JSON.stringify({ tags: r.json.tags, document_type: r.json.document_type, correspondent: r.json.correspondent }));

// Option 1: ownerless metadata (owner=null => visible to everyone)
for (const [kind, o] of [["tags", tag], ["document_types", dt], ["correspondents", co]]) {
  r = await api(ADMIN, "PATCH", `/api/${kind}/${o.id}/`, { owner: null });
  console.log(`set ${kind}/${o.id} owner=null ->`, r.status);
}
r = await api(BOB, "GET", `/api/tags/${tag.id}/`);
console.log("bob tag after owner=null:", r.status, "document_count =", r.json?.document_count, "(bob can read 2 docs carrying it; alice 3)");
r = await api(ALICE, "GET", `/api/tags/${tag.id}/`);
console.log("alice tag document_count =", r.json?.document_count);
r = await api(BOB, "GET", `/api/document_types/${dt.id}/`);
console.log("bob document_type after owner=null:", r.status, "document_count =", r.json?.document_count);
r = await api(BOB, "GET", `/api/correspondents/${co.id}/`);
console.log("bob correspondent after owner=null:", r.status, "document_count =", r.json?.document_count);
r = await api(BOB, "GET", `/api/document_types/?page_size=100`);
console.log("bob document_types list counts:", JSON.stringify((r.json.results ?? []).map((x) => [x.name, x.document_count])));

// Option 2: admin-owned but group-viewable metadata
r = await api(ADMIN, "PATCH", `/api/tags/${secret.id}/`, { set_permissions: { view: { users: [], groups: [1] }, change: { users: [], groups: [] } } });
r = await api(BOB, "GET", `/api/tags/${secret.id}/`);
console.log("bob tag 'geheim' after group view perm:", r.status, "document_count =", r.json?.document_count, "(only on alice's private A)");

// Tasks: does each member see their own consume tasks?
r = await api(ALICE, "GET", `/api/tasks/?task_name=consume_file`);
console.log("alice sees own consume tasks:", Array.isArray(r.json) ? r.json.length : r.status, Array.isArray(r.json) ? JSON.stringify(r.json.map((t) => ({ owner: t.owner, doc: t.related_document }))) : r.text.slice(0, 200));
r = await api(ADMIN, "GET", `/api/tasks/?task_name=consume_file`);
console.log("admin sees consume tasks:", Array.isArray(r.json) ? r.json.length : r.status, Array.isArray(r.json) ? JSON.stringify(r.json.map((t) => ({ owner: t.owner, doc: t.related_document }))) : "");

// New metadata created by a member: who owns it?
r = await api(ALICE, "POST", `/api/tags/`, { name: `alice-created-${Date.now()}` });
console.log("tag created by alice: owner =", r.json?.owner);
const aliceTag = r.json?.id;
r = await api(BOB, "GET", `/api/tags/${aliceTag}/`);
console.log("bob can see alice-created tag:", r.status);
