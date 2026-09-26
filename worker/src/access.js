// Who may read a conversation that is not the whole workspace's.
//
// Three kinds of conversation have a closed door:
//
// - A direct message between two people, `dm:<login>|<login>`: the two
//   logins are in the key, so the key alone says who.
// - A group DM, `g:<id>`: three to nine people, listed in
//   conversation_members. The same name for everybody in it.
// - A private channel, `b:<slug>` with businesses.private = 1: the
//   channel's members, listed in conversation_members too.
//
// A guest (role "guest") is the one exception to "a public channel is
// everybody's": they see only the channels they were let into — rows in
// conversation_members, as for a private channel — and the DMs and groups
// they are in.
//
// Everything that shows what was said — a conversation opened, the
// sidebar's last line, search, Activity, a live event, a Jam, a webhook —
// asks here, or asks resolveChannel, which asks here. A public channel is
// everybody's and costs nothing to check.

export const MAX_GROUP = 9;
const GROUP_ID = /^g:[0-9a-f]{16}$/;

export const isGroupKey = (key) => GROUP_ID.test(String(key || ""));

/// What one person can see beyond the public channels: the closed
/// conversations they are in, and which channels are closed at all.
export async function accessFor(db, orgId, login) {
  const [mine, closed, guest] = await Promise.all([
    db.prepare("SELECT channel FROM conversation_members WHERE org_id = ?1 AND login = ?2").bind(orgId, login).all(),
    db.prepare("SELECT slug FROM businesses WHERE org_id = ?1 AND private = 1").bind(orgId).all(),
    isGuestLogin(db, orgId, login),
  ]);
  return {
    login,
    guest,
    in: new Set((mine.results || []).map((r) => r.channel)),
    closed: new Set((closed.results || []).map((r) => `b:${r.slug}`)),
  };
}

/// Whether this person is a guest here: in only the channels they were let
/// into.
export async function isGuestLogin(db, orgId, login) {
  if (!login) return false;
  const row = await db.prepare(
    "SELECT m.role FROM memberships m JOIN users u ON u.github_id = m.user_github_id WHERE m.org_id = ?1 AND u.login = ?2"
  ).bind(orgId, login).first().catch(() => null);
  return String(row?.role || "").toLowerCase() === "guest";
}

export async function isGuest(db, orgId, githubId) {
  const row = await db.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, String(githubId)).first().catch(() => null);
  return String(row?.role || "").toLowerCase() === "guest";
}

/// Whether the workspace has any guest at all — when it has none, a public
/// channel is simply everybody's and costs nothing to check.
export async function hasGuests(db, orgId) {
  return Boolean(await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND role = 'guest' LIMIT 1").bind(orgId).first().catch(() => null));
}

/// Everyone who can read a public channel in a workspace with guests: every
/// member who is not a guest, and the guests let into it.
export async function publicAudience(db, orgId, key) {
  const { results } = await db.prepare(
    `SELECT u.login FROM memberships m JOIN users u ON u.github_id = m.user_github_id
      WHERE m.org_id = ?1 AND (m.role != 'guest' OR EXISTS (
        SELECT 1 FROM conversation_members c WHERE c.org_id = ?1 AND c.channel = ?2 AND c.login = u.login))
      ORDER BY m.created_at, u.login`
  ).bind(orgId, key).all();
  return (results || []).map((r) => r.login);
}

/// Whether `access` (from accessFor) lets its person read `key`. A DM is
/// decided by its key; the rest by membership.
export function mayRead(key, access) {
  const k = String(key || "");
  if (k.startsWith("b:")) return access.guest ? access.in.has(k) : (!access.closed.has(k) || access.in.has(k));
  if (k.startsWith("g:")) return access.in.has(k);
  if (k.startsWith("dm:")) return k.slice(3).split("|").includes(access.login);
  return false;
}

/// Everyone in a closed conversation, by login — or null for a public
/// channel, which is the whole workspace. In a workspace with guests a
/// public channel is named person by person too, so a guest outside it is
/// never told what was said there.
export async function audienceOf(db, orgId, key) {
  const k = String(key || "");
  if (k.startsWith("dm:")) return k.slice(3).split("|");
  if (k.startsWith("g:") || (k.startsWith("b:") && await isPrivate(db, orgId, k.slice(2)))) {
    const { results } = await db.prepare("SELECT login FROM conversation_members WHERE org_id = ?1 AND channel = ?2 ORDER BY added_at, login").bind(orgId, k).all();
    return (results || []).map((r) => r.login);
  }
  if (k.startsWith("b:") && await hasGuests(db, orgId)) return publicAudience(db, orgId, k);
  return null;
}

export async function isPrivate(db, orgId, slug) {
  const row = await db.prepare("SELECT private FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug).first().catch(() => null);
  return Boolean(row?.private);
}

export async function membersOf(db, orgId, key) {
  const { results } = await db.prepare("SELECT login FROM conversation_members WHERE org_id = ?1 AND channel = ?2 ORDER BY added_at, login").bind(orgId, key).all();
  return (results || []).map((r) => r.login);
}

export async function addMembers(db, { orgId, key, logins, addedBy }) {
  const now = new Date().toISOString();
  const list = [...new Set(logins.filter(Boolean))];
  if (!list.length) return 0;
  await db.batch(list.map((login) => db
    .prepare("INSERT OR IGNORE INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(orgId, key, login, addedBy || null, now)));
  return list.length;
}

export async function removeMember(db, { orgId, key, login }) {
  await db.prepare("DELETE FROM conversation_members WHERE org_id = ?1 AND channel = ?2 AND login = ?3").bind(orgId, key, login).run();
}

/// The group DM these exact people already have, or a new one. Three to
/// nine people, the caller among them; the same set of people always finds
/// the same conversation, as in Slack.
export async function groupFor(db, { orgId, logins, createdBy }) {
  const set = [...new Set(logins)].sort();
  if (set.length < 3 || set.length > MAX_GROUP) return null;
  const { results } = await db.prepare(
    `SELECT channel FROM conversation_members WHERE org_id = ?1 AND channel LIKE 'g:%' AND login = ?2`
  ).bind(orgId, createdBy).all();
  for (const r of results || []) {
    const have = (await membersOf(db, orgId, r.channel)).sort();
    if (have.length === set.length && have.every((l, i) => l === set[i])) return r.channel;
  }
  const key = `g:${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  await addMembers(db, { orgId, key, logins: set, addedBy: createdBy });
  return key;
}

/// The group DMs one person is in, with who else is there.
export async function groupsOf(db, orgId, login) {
  const { results } = await db.prepare(
    `SELECT c.channel, c.login FROM conversation_members c
      WHERE c.org_id = ?1 AND c.channel LIKE 'g:%'
        AND c.channel IN (SELECT channel FROM conversation_members WHERE org_id = ?1 AND login = ?2)
      ORDER BY c.channel, c.added_at, c.login`
  ).bind(orgId, login).all();
  const out = new Map();
  for (const r of results || []) {
    if (!out.has(r.channel)) out.set(r.channel, []);
    out.get(r.channel).push(r.login);
  }
  return [...out.entries()].map(([key, logins]) => ({ key, logins }));
}
