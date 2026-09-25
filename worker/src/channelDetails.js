import { describeSchedule } from "./schedule.js";
import { serverText } from "./serverCopy.js";

// A channel, described: what it is for, who is in it — people and the agents
// that act there — what has been shared in it, and what runs on a schedule
// into it. The panel a chat client opens from the channel's header.

export const MAX_DESCRIPTION = 500;

// Links, as a person pastes them: up to the first space or closing bracket.
const LINK = /https?:\/\/[^\s<>"'）」)\]]+/g;

/// What a business channel is, from its row; a direct conversation has none.
export async function channelRow(db, orgId, key) {
  if (!key.startsWith("b:")) return null;
  return db
    .prepare("SELECT slug, name, description, created_by, created_at FROM businesses WHERE org_id = ?1 AND slug = ?2")
    .bind(orgId, key.slice(2))
    .first()
    .catch(() => null);
}

/// Say what a channel is for. Any member may, as with its name.
export async function setDescription(db, orgId, key, text) {
  if (!key.startsWith("b:")) return { error: "Only a channel has a description.", status: 400 };
  const value = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (value.length > MAX_DESCRIPTION) return { error: `A description is at most ${MAX_DESCRIPTION} characters.`, status: 400 };
  const res = await db
    .prepare("UPDATE businesses SET description = ?3 WHERE org_id = ?1 AND slug = ?2")
    .bind(orgId, key.slice(2), value || null)
    .run();
  if (!(res?.meta?.changes > 0)) return { error: "No such channel.", status: 404 };
  return { description: value || null };
}

/// The links shared in a conversation, newest first, each with who shared
/// it and the message it came in — the channel's attachments.
export function linksIn(rows, members) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const url of String(row.body || "").match(LINK) || []) {
      const clean = url.replace(/[.,;:!?。、]+$/u, "");
      if (seen.has(clean)) continue;
      seen.add(clean);
      let host = "";
      try { host = new URL(clean).host.replace(/^www\./, ""); } catch { continue; }
      const author = row.kind === "ai" ? null : members.find((m) => m.login === row.author_login);
      out.push({
        url: clean,
        host,
        messageId: row.id,
        authorName: row.kind === "ai" ? null : (author?.name || null),
        at: row.created_at,
      });
    }
  }
  return out;
}

/// Everything the details panel shows. `resolved` is the channel as
/// resolveChannel returned it; `viewer` the person looking.
export async function channelDetails(db, orgId, { resolved, viewer, members, locale = "en" }) {
  const key = resolved.key;
  const [row, linkRows, routineRows, agentRows, firstRow] = await Promise.all([
    channelRow(db, orgId, key),
    db.prepare(
      `SELECT id, author_login, kind, body, created_at FROM channel_messages
        WHERE org_id = ?1 AND channel = ?2 AND deleted_at IS NULL AND body LIKE '%http%'
        ORDER BY created_at DESC LIMIT 200`
    ).bind(orgId, key).all(),
    db.prepare(
      `SELECT r.*, u.name AS owner_name FROM routines r LEFT JOIN users u ON u.login = r.owner_login
        WHERE r.org_id = ?1 AND r.channel = ?2 ORDER BY r.created_at ASC`
    ).bind(orgId, key).all(),
    // The agents that act in this workspace: every connected tool someone
    // gave a token, by the name they gave it.
    db.prepare(
      `SELECT t.name, t.last_used_at, u.name AS owner_name FROM api_tokens t LEFT JOIN users u ON u.github_id = t.github_id
        WHERE t.org_id = ?1 ORDER BY t.created_at ASC`
    ).bind(orgId).all(),
    db.prepare("SELECT MIN(created_at) AS at FROM channel_messages WHERE org_id = ?1 AND channel = ?2").bind(orgId, key).first(),
  ]);

  const people = (resolved.kind === "dm"
    ? members.filter((m) => resolved.logins.includes(m.login))
    : members
  ).map((m) => ({
    ref: m.ref,
    name: m.name,
    handle: m.handle || null,
    avatarUrl: m.avatarUrl || null,
    title: m.title || m.role || null,
    status: m.status || null,
    awayUntil: m.awayUntil || null,
    you: m.login === viewer.login,
  }));
  const agents = [
    { name: serverText(locale, "channel.agentYourAI"), kind: "ai", owner: null },
    ...[...new Map((agentRows.results || []).map((a) => [a.name, a])).values()].map((a) => ({
      name: a.name, kind: "agent", owner: a.owner_name || null, lastSeenAt: a.last_used_at || null,
    })),
  ];
  const automations = (routineRows.results || []).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    schedule: describeSchedule(r, locale),
    enabled: Boolean(r.enabled),
    ownerName: r.owner_name || null,
    mine: r.owner_github_id === String(viewer.github_id),
    nextRunAt: r.enabled ? r.next_run_at : null,
  }));
  const attachments = linksIn(linkRows.results || [], members).slice(0, 60);

  return {
    channel: {
      key,
      kind: resolved.kind === "dm" ? "dm" : "channel",
      name: row?.name || (resolved.kind === "dm" ? resolved.other?.name : resolved.slug) || key,
      slug: resolved.slug || null,
      description: row?.description || null,
      createdAt: row?.created_at || firstRow?.at || null,
      createdBy: row?.created_by ? (members.find((m) => m.userId === String(row.created_by))?.name || null) : null,
    },
    members: { people, agents },
    attachments,
    automations,
    counts: {
      members: people.length + agents.length,
      automations: automations.length,
      attachments: attachments.length,
    },
  };
}
