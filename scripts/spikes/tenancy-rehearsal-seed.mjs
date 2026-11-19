// Tenancy migration rehearsal seed (tenancy-foundation §7.1) — e2e Paperless ONLY.
//
// Recreates the shape of a pre-tenancy install on the throwaway stack: >200
// admin-owned tags, admin-owned metadata, admin-owned AND ownerless documents.
// Stop the e2e auto-tagger first, or it assigns home spaces to the new
// documents before the migration gets to them:
//
//   docker compose --project-directory docker -f docker/docker-compose.e2e.yml stop auto-tagger
//   node scripts/spikes/tenancy-rehearsal-seed.mjs
//
// Also records two answers the unit tests can't give: which owner Paperless
// sets on a POST without `owner`, and on a POST with `owner: null`.
const BASE = "http://127.0.0.1:8100";
if (!BASE.includes(":8100")) throw new Error("refusing: not the e2e port");

const TARGET_TAGS = 210;

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
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

const tokenResp = await fetch(`${BASE}/api/token/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "e2epassword" }),
});
const ADMIN = (await tokenResp.json()).token;
const me = await api(ADMIN, "GET", "/api/users/?username__iexact=admin");
const adminId = me.json.results[0].id;

const stamp = Date.now().toString(36);
const probeDefault = await api(ADMIN, "POST", "/api/tags/", { name: `probe-default-${stamp}` });
const probeNull = await api(ADMIN, "POST", "/api/tags/", { name: `probe-null-${stamp}`, owner: null });

let total = (await api(ADMIN, "GET", "/api/tags/?page_size=1")).json.count;
let created = 0;
while (total < TARGET_TAGS) {
  const r = await api(ADMIN, "POST", "/api/tags/", { name: `rehearsal-${stamp}-${String(created).padStart(3, "0")}` });
  if (r.status !== 201) throw new Error(`tag create ${r.status} ${r.text}`);
  created += 1;
  total += 1;
}
await api(ADMIN, "POST", "/api/correspondents/", { name: `Rehearsal Korrespondent ${stamp}` });
await api(ADMIN, "POST", "/api/document_types/", { name: `Rehearsal Typ ${stamp}` });

async function upload(i) {
  const form = new FormData();
  const text = `Probe-Dokument ${stamp}-${i}\nVersicherungsschein Nr. VS-${stamp}-${i}\nDieses Dokument dient nur dem Test der Mandantenmigration.\n`;
  form.append("document", new Blob([text], { type: "text/plain" }), `rehearsal-${stamp}-${i}.txt`);
  const r = await api(ADMIN, "POST", "/api/documents/post_document/", undefined, { form });
  if (r.status !== 200) throw new Error(`upload ${r.status} ${r.text}`);
  return String(r.json ?? r.text).replace(/"/g, "");
}

async function waitForDoc(taskId) {
  for (let i = 0; i < 120; i += 1) {
    const r = await api(ADMIN, "GET", `/api/tasks/?task_id=${taskId}`);
    const task = Array.isArray(r.json) ? r.json[0] : undefined;
    if (task?.status === "SUCCESS" && task.related_document) return Number(task.related_document);
    if (task?.status === "FAILURE") throw new Error(`consume failed: ${task.result}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`task ${taskId} did not finish`);
}

const docs = [];
for (let i = 0; i < 4; i += 1) docs.push(await waitForDoc(await upload(i)));
const ownerless = docs.slice(2);
for (const id of ownerless) {
  const r = await api(ADMIN, "PATCH", `/api/documents/${id}/`, { owner: null });
  if (r.status !== 200) throw new Error(`clear owner ${id}: ${r.status} ${r.text}`);
}

const summary = {
  admin_user_id: adminId,
  tag_owner_on_post_without_owner: probeDefault.json?.owner ?? null,
  tag_owner_on_post_with_owner_null: probeNull.json?.owner ?? null,
  tags_total: total,
  tags_created: created,
  documents_owned_by_admin: docs.slice(0, 2),
  documents_ownerless: ownerless,
  documents_total: (await api(ADMIN, "GET", "/api/documents/?page_size=1")).json.count,
};
console.log(JSON.stringify(summary, null, 2));
