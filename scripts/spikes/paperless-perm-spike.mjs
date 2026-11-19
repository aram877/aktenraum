// Paperless permission spike — runs ONLY against the throwaway e2e Paperless.
const BASE = "http://127.0.0.1:8100";
if (!BASE.includes(":8100")) throw new Error("refusing: not the e2e port");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const info = (name, detail) => console.log(`INFO  ${name}  — ${detail}`);

async function api(token, method, path, body, { form } = {}) {
  const headers = { Authorization: `Token ${token}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function tokenFor(username, password) {
  const r = await fetch(`${BASE}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`token for ${username}: ${JSON.stringify(j)}`);
  return j.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (res) => (res.json?.results ?? []).map((d) => d.id).sort((a, b) => a - b);

// ---------------------------------------------------------------- setup
const ADMIN = await tokenFor("admin", "e2epassword");

const PERMS = [
  "view_document", "add_document", "change_document", "delete_document",
  "view_tag", "add_tag", "change_tag",
  "view_correspondent", "add_correspondent",
  "view_documenttype", "add_documenttype",
  "view_customfield",
  "view_note", "add_note",
  "view_paperlesstask",
  "view_uisettings", "change_uisettings", "add_uisettings",
];

async function ensureUser(username) {
  const found = await api(ADMIN, "GET", `/api/users/?username__iexact=${username}`);
  if (found.json?.results?.length) return found.json.results[0].id;
  const r = await api(ADMIN, "POST", "/api/users/", {
    username, password: `${username}-pw-123`, is_active: true, is_superuser: false, is_staff: false,
    user_permissions: PERMS,
  });
  if (r.status !== 201) throw new Error(`create ${username}: ${r.status} ${r.text}`);
  return r.json.id;
}
const aliceId = await ensureUser("alice");
const bobId = await ensureUser("bob");
const carolId = await ensureUser("carol");
const ALICE = await tokenFor("alice", "alice-pw-123");
const BOB = await tokenFor("bob", "bob-pw-123");
const CAROL = await tokenFor("carol", "carol-pw-123");

let g = await api(ADMIN, "GET", "/api/groups/?name__iexact=space-haushalt");
let groupId = g.json?.results?.[0]?.id;
if (!groupId) {
  g = await api(ADMIN, "POST", "/api/groups/", { name: "space-haushalt", permissions: [] });
  groupId = g.json.id;
}
for (const uid of [aliceId, bobId]) {
  const u = await api(ADMIN, "GET", `/api/users/${uid}/`);
  const groups = new Set(u.json.groups ?? []);
  groups.add(groupId);
  await api(ADMIN, "PATCH", `/api/users/${uid}/`, { groups: [...groups] });
}

// admin-owned metadata, like scripts/bootstrap-paperless.sh creates today
async function ensureNamed(kind, name, extra = {}) {
  const f = await api(ADMIN, "GET", `/api/${kind}/?name__iexact=${encodeURIComponent(name)}`);
  if (f.json?.results?.length) return f.json.results[0];
  const r = await api(ADMIN, "POST", `/api/${kind}/`, { name, ...extra });
  if (r.status !== 201) throw new Error(`create ${kind} ${name}: ${r.status} ${r.text}`);
  return r.json;
}
const tagAdmin = await ensureNamed("tags", "ai-propagated-spike");
const tagSecret = await ensureNamed("tags", "geheim-alice-only");
const dtype = await ensureNamed("document_types", "Gehaltsabrechnung-spike");
const corr = await ensureNamed("correspondents", "Arbeitgeber GmbH spike");
const cf = await ensureNamed("custom_fields", "ai_summary_spike", { data_type: "string" });
info("admin-created metadata owner", `tag.owner=${tagAdmin.owner} cf.owner=${cf.owner ?? "n/a"}`);

// upload 3 docs as alice (so owner = alice by default)
async function upload(token, title, content) {
  const form = new FormData();
  form.append("document", new Blob([content], { type: "text/plain" }), `${title}.txt`);
  form.append("title", title);
  const r = await api(token, "POST", "/api/documents/post_document/", undefined, { form });
  if (r.status !== 200) throw new Error(`upload ${title}: ${r.status} ${r.text}`);
  return r.json; // task uuid
}
async function waitForDoc(taskId) {
  for (let i = 0; i < 90; i++) {
    const t = await api(ADMIN, "GET", `/api/tasks/?task_id=${taskId}`);
    const task = t.json?.[0];
    if (task?.status === "SUCCESS") return Number(task.related_document);
    if (task?.status === "FAILURE") throw new Error(`task failed: ${task.result}`);
    await sleep(2000);
  }
  throw new Error("task timeout");
}
const stamp = Date.now();
const docA = await waitForDoc(await upload(ALICE, `A-alice-private-${stamp}`, `Lohnabrechnung Alice privat ${stamp} kennwort zebra`));
const docH = await waitForDoc(await upload(ALICE, `H-haushalt-${stamp}`, `Kontoauszug Gemeinschaftskonto ${stamp} kennwort zebra`));
const docS = await waitForDoc(await upload(ALICE, `S-alice-shared-${stamp}`, `Kfz-Kredit Vertrag Alice ${stamp} kennwort zebra`));
info("docs", `A=${docA} H=${docH} S=${docS}`);

// metadata on all three
for (const d of [docA, docH, docS]) {
  await api(ADMIN, "PATCH", `/api/documents/${d}/`, {
    tags: [tagAdmin.id, ...(d === docA ? [tagSecret.id] : [])],
    document_type: dtype.id,
    correspondent: corr.id,
    custom_fields: [{ field: cf.id, value: `summary ${d}` }],
  });
}

// permissions
const perm = (viewUsers, viewGroups, changeUsers = [], changeGroups = []) => ({
  view: { users: viewUsers, groups: viewGroups },
  change: { users: changeUsers, groups: changeGroups },
});
let r;
r = await api(ALICE, "PATCH", `/api/documents/${docA}/`, { owner: aliceId, set_permissions: perm([], []) });
check("owner (alice) can set_permissions on own doc A", r.status === 200, `status ${r.status}`);
r = await api(ALICE, "PATCH", `/api/documents/${docH}/`, { set_permissions: perm([], [groupId], [], [groupId]) });
check("owner can grant group view+change on H", r.status === 200, `status ${r.status}`);
r = await api(ALICE, "PATCH", `/api/documents/${docS}/`, { set_permissions: perm([bobId], []) });
check("owner can grant user view on S (share)", r.status === 200, `status ${r.status}`);

// ---------------------------------------------------------------- tests as bob
const visibleBob = ids(await api(BOB, "GET", "/api/documents/?page_size=100"));
check("bob list = {H,S}", JSON.stringify(visibleBob) === JSON.stringify([docH, docS].sort((a, b) => a - b)), `got ${visibleBob}`);
const countBob = (await api(BOB, "GET", "/api/documents/?page_size=1")).json?.count;
check("bob list count == 2 (pagination count respects perms)", countBob === 2, `count ${countBob}`);

for (const [label, path] of [
  ["detail", `/api/documents/${docA}/`],
  ["preview", `/api/documents/${docA}/preview/`],
  ["download", `/api/documents/${docA}/download/`],
  ["thumb", `/api/documents/${docA}/thumb/`],
  ["metadata", `/api/documents/${docA}/metadata/`],
  ["notes", `/api/documents/${docA}/notes/`],
  ["suggestions", `/api/documents/${docA}/suggestions/`],
  ["history", `/api/documents/${docA}/history/`],
]) {
  r = await api(BOB, "GET", path);
  check(`bob denied A ${label}`, r.status === 403 || r.status === 404, `status ${r.status}`);
}

r = await api(BOB, "GET", `/api/documents/?query=zebra&page_size=100`);
check("bob full-text ?query= excludes A", !ids(r).includes(docA), `got ${ids(r)} (status ${r.status})`);
r = await api(BOB, "GET", `/api/documents/?content__icontains=zebra&page_size=100`);
check("bob content__icontains excludes A", !ids(r).includes(docA), `got ${ids(r)}`);
r = await api(BOB, "GET", `/api/documents/?tags__id__in=${tagAdmin.id}&page_size=100`);
check("bob tags__id__in excludes A", !ids(r).includes(docA), `got ${ids(r)}`);
r = await api(BOB, "GET", `/api/documents/?tags__id__none=${tagSecret.id}&page_size=100`);
check("bob tags__id__none excludes A", !ids(r).includes(docA), `got ${ids(r)}`);
r = await api(BOB, "GET", `/api/documents/?document_type__id=${dtype.id}&page_size=100`);
check("bob document_type__id excludes A", !ids(r).includes(docA), `got ${ids(r)}`);
r = await api(BOB, "GET", `/api/documents/?id__in=${docA},${docH}&page_size=100`);
check("bob id__in excludes A", !ids(r).includes(docA), `got ${ids(r)}`);
r = await api(BOB, "GET", `/api/documents/?more_like_id=${docH}&page_size=100`);
check("bob more_like_id excludes A", !ids(r).includes(docA), `got ${ids(r)} (status ${r.status})`);
r = await api(BOB, "GET", `/api/search/?query=zebra`);
const gsDocs = (r.json?.documents ?? []).map((d) => d.id);
check("bob global /api/search/ excludes A", !gsDocs.includes(docA), `docs ${gsDocs} (status ${r.status})`);
r = await api(BOB, "GET", `/api/search/autocomplete/?term=lohn`);
info("bob autocomplete 'lohn' (term leak from A?)", `${r.status} ${r.text.slice(0, 200)}`);

// metadata visibility / counts
r = await api(BOB, "GET", `/api/tags/${tagAdmin.id}/`);
check("bob can resolve admin-owned tag", r.status === 200, `status ${r.status}`);
info("bob sees tag document_count", `${r.json?.document_count} (alice sees 3, bob can read 2)`);
r = await api(BOB, "GET", `/api/tags/?page_size=200`);
const secretVisible = (r.json?.results ?? []).some((t) => t.id === tagSecret.id);
info("bob sees admin-owned tag 'geheim-alice-only' in tag list", String(secretVisible));
r = await api(BOB, "GET", `/api/document_types/${dtype.id}/`);
check("bob can resolve admin-owned document type", r.status === 200, `status ${r.status}`);
info("bob document_type document_count (library chips)", `${r.json?.document_count} (should be 2)`);
r = await api(BOB, "GET", `/api/correspondents/${corr.id}/`);
info("bob correspondent document_count", `${r.status} count=${r.json?.document_count} (should be 2)`);
r = await api(BOB, "GET", `/api/custom_fields/${cf.id}/`);
check("bob can resolve admin-owned custom field", r.status === 200, `status ${r.status}`);
r = await api(BOB, "GET", `/api/documents/${docH}/`);
const cfOnH = (r.json?.custom_fields ?? []).find((x) => x.field === cf.id);
check("bob sees custom field value on H", cfOnH?.value === `summary ${docH}`, JSON.stringify(cfOnH));
r = await api(BOB, "GET", `/api/statistics/`);
info("bob /api/statistics/ documents_total", `${r.status} total=${r.json?.documents_total} inbox=${r.json?.documents_inbox}`);

// write semantics
r = await api(BOB, "PATCH", `/api/documents/${docS}/`, { title: "bob-was-here" });
check("bob (viewer) cannot PATCH S", r.status === 403 || r.status === 404, `status ${r.status}`);
r = await api(BOB, "PATCH", `/api/documents/${docH}/`, { title: `H-edited-by-bob-${stamp}` });
check("bob (group change) can PATCH H", r.status === 200, `status ${r.status}`);
r = await api(BOB, "PATCH", `/api/documents/${docH}/`, { set_permissions: perm([bobId, carolId], [groupId], [], [groupId]) });
check("bob (non-owner) cannot change permissions on H", r.status === 403, `status ${r.status} ${r.text.slice(0, 120)}`);
r = await api(BOB, "PATCH", `/api/documents/${docH}/`, { owner: bobId });
check("bob (non-owner) cannot take ownership of H", r.status === 403, `status ${r.status}`);
r = await api(BOB, "POST", `/api/documents/bulk_edit/`, { documents: [docA], method: "add_tag", parameters: { tag: tagAdmin.id } });
check("bob bulk_edit on A denied", r.status === 403, `status ${r.status} ${r.text.slice(0, 120)}`);
r = await api(BOB, "POST", `/api/documents/bulk_edit/`, { documents: [docS], method: "set_permissions", parameters: { set_permissions: perm([bobId], [], [bobId]) } });
check("bob bulk_edit set_permissions on S denied", r.status === 403, `status ${r.status} ${r.text.slice(0, 120)}`);
r = await api(BOB, "DELETE", `/api/documents/${docH}/`);
info("bob (group change) DELETE H", `status ${r.status} — Paperless treats delete as change?`);
if (r.status === 204) await api(ADMIN, "POST", `/api/trash/`, { documents: [docH], action: "restore" });

// tasks visibility (ingest activity)
r = await api(BOB, "GET", `/api/tasks/?task_name=consume_file`);
info("bob sees alice's consume tasks", `${Array.isArray(r.json) ? r.json.length : r.status} tasks visible`);

// trash visibility
r = await api(ALICE, "DELETE", `/api/documents/${docA}/`);
r = await api(BOB, "GET", `/api/trash/?page_size=100`);
const trashBob = (r.json?.results ?? []).map((d) => d.id);
check("bob trash excludes alice's trashed A", !trashBob.includes(docA), `got ${trashBob}`);
r = await api(BOB, "POST", `/api/trash/`, { documents: [docA], action: "restore" });
check("bob cannot restore A from trash", r.status >= 400, `status ${r.status}`);
await api(ALICE, "POST", `/api/trash/`, { documents: [docA], action: "restore" });

// carol: no group, no share
r = await api(CAROL, "GET", "/api/documents/?page_size=100");
check("carol (no space, no share) sees nothing", ids(r).length === 0, `got ${ids(r)}`);

// revoke share
r = await api(ALICE, "PATCH", `/api/documents/${docS}/`, { set_permissions: perm([], []) });
r = await api(BOB, "GET", `/api/documents/${docS}/`);
check("revoke share takes effect immediately", r.status === 403 || r.status === 404, `status ${r.status}`);
r = await api(BOB, "GET", `/api/documents/?query=zebra&page_size=100`);
check("revoked S also gone from full-text", !ids(r).includes(docS), `got ${ids(r)}`);

// group removal
const ub = await api(ADMIN, "GET", `/api/users/${bobId}/`);
await api(ADMIN, "PATCH", `/api/users/${bobId}/`, { groups: (ub.json.groups ?? []).filter((x) => x !== groupId) });
r = await api(BOB, "GET", `/api/documents/${docH}/`);
check("removing bob from group revokes H", r.status === 403 || r.status === 404, `status ${r.status}`);
await api(ADMIN, "PATCH", `/api/users/${bobId}/`, { groups: [...(ub.json.groups ?? [])] });

// admin (service token) sees all
r = await api(ADMIN, "GET", "/api/documents/?page_size=100");
check("admin/service token sees A,H,S", [docA, docH, docS].every((d) => ids(r).includes(d)), `got ${ids(r)}`);

// full_perms read-back
r = await api(ALICE, "GET", `/api/documents/${docH}/?full_perms=true`);
info("alice full_perms on H", JSON.stringify(r.json?.permissions));

// ---------------------------------------------------------------- summary
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED:\n" + failed.map((f) => ` - ${f.name}: ${f.detail}`).join("\n"));
