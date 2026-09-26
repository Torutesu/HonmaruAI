// Two ways a person arranges the people and places they work with.
//
// User groups — `@sales`, `@営業` — belong to the workspace: a handle that
// names several people at once, so one mention reaches all of them the way
// naming each would (Activity, pushes, the AI's routing). Anyone in the
// workspace may make one or change who is in it, as in Slack; whoever made
// it, or an admin, may delete it.
//
// The sidebar — starred conversations and sections of your own — belongs to
// one person in one workspace, and only ever arranges what they can already
// see: a conversation named here that they cannot read is simply not shown.

const HANDLE = /^[\p{L}\p{N}_.-]{1,30}$/u;
const MAX_GROUPS = 100;
const MAX_SECTIONS = 20;
const MAX_VIEWS = 200;

const fold = (s) => String(s || "").normalize("NFKC").toLowerCase();

/// A handle as it may be stored: what follows "@", without it.
export function cleanHandle(raw) {
  const h = fold(String(raw || "").trim().replace(/^[@＠]+/, ""));
  return HANDLE.test(h) ? h : null;
}

// ---- User groups ----

/// Every group in the workspace, with its people by login.
export async function groupsIn(db, orgId) {
  const [{ results: groups }, { results: members }] = await Promise.all([
    db.prepare("SELECT handle, name, created_by, created_at FROM user_groups WHERE org_id = ?1 ORDER BY handle").bind(orgId).all(),
    db.prepare("SELECT handle, login FROM user_group_members WHERE org_id = ?1").bind(orgId).all(),
  ]).catch(() => [{ results: [] }, { results: [] }]);
  const by = new Map();
  for (const m of members || []) by.set(m.handle, [...(by.get(m.handle) || []), m.login]);
  return (groups || []).map((g) => ({ handle: g.handle, name: g.name, createdBy: g.created_by, createdAt: g.created_at, logins: by.get(g.handle) || [] }));
}

/// Which groups each person is in, for the member list: `login → [handle]`.
export async function groupHandlesByLogin(db, orgId) {
  const { results } = await db.prepare("SELECT handle, login FROM user_group_members WHERE org_id = ?1").bind(orgId).all()
    .catch(() => ({ results: [] }));
  const out = new Map();
  for (const r of results || []) out.set(r.login, [...(out.get(r.login) || []), r.handle]);
  return out;
}

/// A group as a client sees it: people by ref, never by login.
export function toClientGroup(group, members) {
  const refOf = new Map(members.map((m) => [m.login, m.ref]));
  return {
    handle: group.handle,
    name: group.name,
    refs: group.logins.map((l) => refOf.get(l)).filter(Boolean),
    createdBy: refOf.get(group.createdBy) || null,
  };
}

/// Make a group, or change one: its name and who is in it. `refs` are the
/// people, by ref; anyone not in the workspace is left out.
export async function saveGroup(db, orgId, { handle: raw, name, refs, login, members, creating }) {
  const handle = cleanHandle(raw);
  if (!handle) return { error: "A group's handle is letters, numbers, - _ and ., up to 30.", status: 400 };
  // A handle a person already answers to would make "@x" mean two things.
  const taken = members.some((m) => [m.handle, String(m.login || "").split("@")[0]].filter(Boolean).map(fold).includes(handle));
  if (taken) return { error: `@${handle} is already somebody's name here.`, status: 409 };
  const agent = await db.prepare("SELECT 1 FROM custom_agents WHERE org_id = ?1 AND handle = ?2 AND scope = 'team' AND deleted_at IS NULL")
    .bind(orgId, handle).first().catch(() => null);
  if (agent) return { error: `@${handle} is already an agent here.`, status: 409 };
  const existing = await db.prepare("SELECT handle FROM user_groups WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle).first();
  if (creating && existing) return { error: `@${handle} already exists.`, status: 409 };
  if (!creating && !existing) return { error: "No such group.", status: 404 };
  if (creating) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM user_groups WHERE org_id = ?1").bind(orgId).first();
    if ((count?.n || 0) >= MAX_GROUPS) return { error: "This workspace has all the groups it can hold.", status: 400 };
  }
  const byRef = new Map(members.map((m) => [m.ref, m.login]));
  const logins = [...new Set((Array.isArray(refs) ? refs : []).map((r) => byRef.get(r)).filter(Boolean))];
  const title = String(name || "").trim().slice(0, 60) || handle;
  const at = new Date().toISOString();
  await db.batch([
    creating
      ? db.prepare("INSERT INTO user_groups (org_id, handle, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(orgId, handle, title, login, at)
      : db.prepare("UPDATE user_groups SET name = ?3 WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle, title),
    db.prepare("DELETE FROM user_group_members WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle),
    ...logins.map((l) => db.prepare("INSERT INTO user_group_members (org_id, handle, login) VALUES (?1, ?2, ?3)").bind(orgId, handle, l)),
  ]);
  const group = (await groupsIn(db, orgId)).find((g) => g.handle === handle);
  return { group };
}

/// Delete one: whoever made it, or an admin.
export async function deleteGroup(db, orgId, { handle: raw, login, isAdmin }) {
  const handle = cleanHandle(raw);
  const row = handle ? await db.prepare("SELECT created_by FROM user_groups WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle).first() : null;
  if (!row) return { error: "No such group.", status: 404 };
  if (row.created_by !== login && !isAdmin) return { error: "Only whoever made it, or an admin, can delete it.", status: 403 };
  await db.batch([
    db.prepare("DELETE FROM user_group_members WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle),
    db.prepare("DELETE FROM user_groups WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle),
  ]);
  return { deleted: handle };
}

// ---- The sidebar ----

const cleanView = (v) => (typeof v === "string" && /^(b|dm|g):[^\s]{1,200}$/.test(v) ? v : null);

/// A sidebar as stored: starred views, then sections of your own, each a
/// name and the views in it. Anything malformed is dropped, not refused.
export function cleanSidebar(input) {
  const starred = [...new Set((Array.isArray(input?.starred) ? input.starred : []).map(cleanView).filter(Boolean))].slice(0, MAX_VIEWS);
  const sections = [];
  const placed = new Set();
  for (const s of (Array.isArray(input?.sections) ? input.sections : []).slice(0, MAX_SECTIONS)) {
    const name = String(s?.name || "").trim().slice(0, 40);
    if (!name) continue;
    const id = typeof s?.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? s.id : crypto.randomUUID().slice(0, 8);
    // A conversation sits in one section at most.
    const views = (Array.isArray(s?.views) ? s.views : []).map(cleanView).filter((v) => v && !placed.has(v)).slice(0, MAX_VIEWS);
    for (const v of views) placed.add(v);
    sections.push({ id, name, views, collapsed: Boolean(s?.collapsed) });
  }
  return { starred, sections };
}

export async function getSidebar(db, orgId, login) {
  const row = await db.prepare("SELECT data FROM sidebar_prefs WHERE org_id = ?1 AND login = ?2").bind(orgId, login).first().catch(() => null);
  try { return cleanSidebar(row ? JSON.parse(row.data) : {}); } catch { return cleanSidebar({}); }
}

export async function saveSidebar(db, orgId, login, input) {
  const clean = cleanSidebar(input);
  await db.prepare(
    `INSERT INTO sidebar_prefs (org_id, login, data, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (org_id, login) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(orgId, login, JSON.stringify(clean), new Date().toISOString()).run();
  return clean;
}
