/// "Mika joined": a line in the team's first public channel when somebody
/// new comes in, the way Slack says it in #general. The row carries only who
/// (its author) and the kind; each reader's screen writes the words in its
/// own language. Never for a guest, who sees only the channels they were
/// given; never twice for one arrival; and not where an invitation that
/// named this channel already introduced them (welcome.js).
///
/// And the newcomer is greeted: a direct conversation with the workspace's
/// owner opens with the AI saying, in the newcomer's language, how the place
/// works — channels, "@AI" to ask, ✦ for a decision, "@" for an agent,
/// translation.

import { postMessage } from "./channels.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";
import { teamName } from "./orgs.js";

const RECENT_MS = 60 * 60 * 1000;

export async function announceJoin(env, orgId, login) {
  const db = env?.DB;
  if (!db || !orgId || !login) return null;
  const who = await db.prepare(
    `SELECT u.login, u.name, u.locale, m.role FROM users u JOIN memberships m ON m.user_github_id = u.github_id AND m.org_id = ?1 WHERE u.login = ?2`
  ).bind(orgId, login).first().catch(() => null);
  if (!who || String(who.role || "").trim().toLowerCase() === "guest") return null;
  // The welcome DM first: it keeps itself to once (not when the two have
  // already talked), whatever has been said in the channels.
  await welcome(env, orgId, who).catch((err) => console.error("welcome DM failed", err?.message || err));
  // Said already — by an invitation that named channels, or a moment ago.
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const said = await db.prepare(
    "SELECT 1 FROM channel_messages WHERE org_id = ?1 AND kind = 'joined' AND author_login = ?2 AND created_at >= ?3 LIMIT 1"
  ).bind(orgId, login, since).first().catch(() => null);
  if (said) return null;
  const room = await db.prepare(
    "SELECT slug FROM businesses WHERE org_id = ?1 AND archived_at IS NULL AND COALESCE(private, 0) = 0 ORDER BY created_at LIMIT 1"
  ).bind(orgId).first().catch(() => null);
  if (!room) return null;
  const key = `b:${room.slug}`;
  const introduced = who.name ? await db.prepare(
    "SELECT 1 FROM channel_messages WHERE org_id = ?1 AND channel = ?2 AND kind = 'ai' AND created_at >= ?3 AND instr(body, ?4) > 0 LIMIT 1"
  ).bind(orgId, key, new Date(Date.now() - 5 * 60 * 1000).toISOString(), who.name).first().catch(() => null) : null;
  if (introduced) return null;
  const out = await postMessage(db, { orgId, key, authorLogin: login, body: "joined", kind: "joined" });
  if (!out.row) return null;
  const { broadcastStored } = await import("./channelRoutes.js");
  await broadcastStored(env, orgId, key, out.row).catch(() => {});
  return out.row;
}

/// The first words in the newcomer's direct conversation with the owner:
/// the AI's welcome, once — not when the two have already talked.
async function welcome(env, orgId, who) {
  const db = env.DB;
  const owner = await db.prepare(
    `SELECT u.login, u.name FROM memberships m JOIN users u ON u.github_id = m.user_github_id
      WHERE m.org_id = ?1 AND LOWER(TRIM(m.role)) IN ('owner', 'admin') AND u.login != ?2
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at ASC LIMIT 1`
  ).bind(orgId, who.login).first().catch(() => null);
  if (!owner?.login) return null;
  const key = `dm:${[who.login, owner.login].sort().join("|")}`;
  const talked = await db.prepare("SELECT 1 FROM channel_messages WHERE org_id = ?1 AND channel = ?2 LIMIT 1").bind(orgId, key).first().catch(() => null);
  if (talked) return null;
  const copy = await loadCopy(env, who.locale || "en", { orgId });
  const team = await teamName(db, orgId).catch(() => "") || serverText(copy, "welcome.yourTeam");
  const body = serverText(copy, "welcome.dm", { name: who.name || "", team, owner: owner.name || owner.login });
  const out = await postMessage(db, { orgId, key, authorLogin: null, body, kind: "ai" });
  if (!out.row) return null;
  const { broadcastStored } = await import("./channelRoutes.js");
  await broadcastStored(env, orgId, key, out.row).catch(() => {});
  return out.row;
}
