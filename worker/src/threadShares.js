import { getMessage } from "./channels.js";
import { scan } from "./dlp.js";
import { sha256Hex } from "./auth.js";
import { accessFor, mayRead } from "./access.js";

async function sharingBoundary(db, orgId, channel, userId) {
  const creator = await db.prepare(`SELECT u.login FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND m.user_github_id=?2 AND m.role!='guest'`).bind(orgId, String(userId)).first();
  if (!creator || !mayRead(channel, await accessFor(db, orgId, creator.login))) return null;
  let visibility = "closed";
  if (channel.startsWith("b:")) {
    const room = await db.prepare("SELECT private FROM businesses WHERE org_id=?1 AND slug=?2").bind(orgId, channel.slice(2)).first();
    if (!room) return null;
    visibility = room.private ? "private" : "workspace";
  }
  const { results = [] } = await db.prepare("SELECT login FROM conversation_members WHERE org_id=?1 AND channel=?2 ORDER BY login").bind(orgId, channel).all();
  return sha256Hex(JSON.stringify({ channel, visibility, members: results.map(row => row.login) }));
}

export async function threadSharePolicy(db, orgId) {
  const row = await db.prepare("SELECT enabled,version FROM channel_thread_share_policy WHERE org_id=?1").bind(orgId).first();
  return { enabled: Boolean(row?.enabled), version: row?.version || 0 };
}

export async function setThreadSharePolicy(db, orgId, userId, enabled, version) {
  if (typeof enabled !== "boolean" || !Number.isSafeInteger(version) || version < 0)
    return { error: "A current sharing policy version is required.", status: 400 };
  const now = new Date().toISOString();
  const update = version === 0
    ? db.prepare("INSERT OR IGNORE INTO channel_thread_share_policy (org_id,enabled,version,updated_by,updated_at) VALUES (?1,?2,1,?3,?4)").bind(orgId, Number(enabled), String(userId), now)
    : db.prepare("UPDATE channel_thread_share_policy SET enabled=?2,version=version+1,updated_by=?3,updated_at=?4 WHERE org_id=?1 AND version=?5").bind(orgId, Number(enabled), String(userId), now, version);
  // A policy change revokes existing publications. Enabling again never
  // resurrects a link that was invalidated by a prior administrator decision.
  const results = await db.batch([update,
    db.prepare("UPDATE channel_thread_shares SET revoked_at=COALESCE(revoked_at,?2),snapshot='{}' WHERE org_id=?1 AND changes()>0")
      .bind(orgId, now),
  ]);
  if (!results[0].meta?.changes) return { error: "Sharing policy changed. Reload before saving.", status: 409 };
  return { policy: await threadSharePolicy(db, orgId) };
}

// Prepare a reviewable snapshot. This function does not publish it or create
// any bearer token. Public rendering must consume only this explicit shape.
export async function previewThreadShare(db, orgId, channel, threadId) {
  const root = await getMessage(db, orgId, threadId);
  if (!root || root.deleted_at || root.parent_id || root.channel !== channel)
    return { error: "No such thread.", status: 404 };
  const { results = [] } = await db.prepare(`SELECT m.id, m.body, m.kind, m.created_at,
    COALESCE(a.name,u.name,CASE WHEN m.kind='ai' THEN 'AI' ELSE 'Member' END) AS name,
    (SELECT COUNT(*) FROM message_files f WHERE f.org_id=m.org_id AND f.channel=m.channel AND f.message_id=m.id) AS attachments
    FROM channel_messages m LEFT JOIN users u ON u.login=m.author_login
    LEFT JOIN custom_agents a ON a.org_id=m.org_id AND 'agent:'||a.id=m.author_login
    WHERE m.org_id=?1 AND m.channel=?2 AND (m.id=?3 OR m.parent_id=?3)
      AND m.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM channel_messages r WHERE r.org_id=?1 AND r.id=?3 AND r.deleted_at IS NULL)
    ORDER BY CASE WHEN m.id=?3 THEN 0 ELSE 1 END,m.created_at,m.rowid`)
    .bind(orgId, channel, threadId).all();
  if (!results.some(row => row.id === threadId)) return { error: "No such thread.", status: 404 };
  const snapshot = {
    version: 1,
    title: root.thread_title || root.body.slice(0, 160),
    messages: results.map(row => ({
      author: row.name,
      body: row.body,
      createdAt: row.created_at,
      kind: ["ai", "agent"].includes(row.kind) ? "assistant" : "person",
      // No IDs, signed media URLs, avatars, app definitions or record data.
      attachmentCount: Number(row.attachments) || 0,
    })),
  };
  // Public sharing must fail closed if policy storage cannot be read.
  const { results: rules = [] } = await db.prepare("SELECT * FROM dlp_rules WHERE org_id=?1 AND enabled=1 ORDER BY created_at,id").bind(orgId).all();
  const hits = new Map();
  for (const text of [snapshot.title, ...snapshot.messages.flatMap(message => [message.author, message.body])]) {
    for (const hit of scan(rules, text)) hits.set(hit.id, hit);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  return { snapshot, digest, dlp: [...hits.values()], blocked: [...hits.values()].some(hit => hit.action === "block") };
}

// Called only after route-level publication policy and channel authorization.
// The preview digest binds the action to the content the user reviewed.
export async function storeThreadShare(db, { orgId, channel, threadId, userId, digest, acknowledgeWarnings = false }, now = Date.now()) {
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    return { error: "Review the thread before sharing.", status: 400 };
  const policy = await threadSharePolicy(db, orgId);
  if (!policy.enabled) return { error: "Public sharing is disabled in this workspace.", status: 403 };
  const boundary = await sharingBoundary(db, orgId, channel, userId);
  if (!boundary) return { error: "No such thread.", status: 404 };
  const preview = await previewThreadShare(db, orgId, channel, threadId);
  if (preview.error) return preview;
  if (preview.blocked) return { error: "Workspace policy blocks this share.", status: 403 };
  if (preview.digest !== digest) return { error: "The conversation changed. Review the latest preview.", status: 409 };
  if (preview.dlp.length && acknowledgeWarnings !== true)
    return { error: "Acknowledge the policy warnings before sharing.", status: 409, dlp: preview.dlp };
  const snapshot = JSON.stringify(preview.snapshot);
  if (new TextEncoder().encode(snapshot).length > 900000)
    return { error: "This conversation exceeds the snapshot storage limit.", status: 413 };
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID(), createdAt = new Date(now).toISOString(), expiresAt = new Date(now + 7 * 86400000).toISOString();
  const result = await db.prepare(`INSERT INTO channel_thread_shares
    (id,org_id,channel,message_id,created_by,token_hash,snapshot,digest,created_at,expires_at,access_digest)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?12
    WHERE EXISTS (SELECT 1 FROM channel_messages WHERE org_id=?2 AND channel=?3 AND id=?4 AND deleted_at IS NULL AND parent_id IS NULL)
      AND EXISTS (SELECT 1 FROM channel_thread_share_policy WHERE org_id=?2 AND enabled=1 AND version=?11)
      AND EXISTS (SELECT 1 FROM memberships WHERE org_id=?2 AND user_github_id=?5 AND role!='guest')`)
    .bind(id, orgId, channel, threadId, String(userId), await sha256Hex(token), snapshot, digest, createdAt, expiresAt, policy.version, boundary).run();
  if (!result.meta?.changes) return { error: "Sharing access or policy changed. Review before trying again.", status: 409 };
  return { id, token, createdAt, expiresAt };
}

// The public route returns no-store/noindex headers. Render snapshot strings
// as escaped text, never as trusted HTML or auto-loaded external resources.
export async function readThreadShare(db, token, now = Date.now()) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare(`SELECT s.* FROM channel_thread_shares s
    JOIN channel_thread_share_policy p ON p.org_id=s.org_id AND p.enabled=1
    JOIN channel_messages m ON m.id=s.message_id AND m.org_id=s.org_id AND m.channel=s.channel AND m.deleted_at IS NULL
    WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2`)
    .bind(await sha256Hex(token), new Date(now).toISOString()).first();
  if (!row) return null;
  const boundary = await sharingBoundary(db, row.org_id, row.channel, row.created_by);
  if (!boundary || boundary !== row.access_digest) {
    await revokeOwnThreadShare(db, row.org_id, row.created_by, row.id, now);
    return null;
  }
  return { snapshot: JSON.parse(row.snapshot), expiresAt: row.expires_at };
}

// A creator can revoke their own publication even after losing room access.
// Workspace membership and administrator overrides belong to the route.
export async function revokeOwnThreadShare(db, orgId, userId, id, now = Date.now()) {
  const row = await db.prepare("SELECT id FROM channel_thread_shares WHERE org_id=?1 AND created_by=?2 AND id=?3")
    .bind(orgId, String(userId), id).first();
  if (!row) return { error: "No such share.", status: 404 };
  await db.prepare("UPDATE channel_thread_shares SET revoked_at=COALESCE(revoked_at,?4),snapshot='{}' WHERE org_id=?1 AND created_by=?2 AND id=?3")
    .bind(orgId, String(userId), id, new Date(now).toISOString()).run();
  return { revoked: true };
}

// Retain only non-content metadata for expired publications. Reading already
// rejects expired links; this job also removes their stored conversation text.
export async function expireThreadShares(db, now = Date.now()) {
  return db.prepare(`UPDATE channel_thread_shares SET revoked_at=COALESCE(revoked_at,?1),snapshot='{}'
    WHERE expires_at<=?1 AND snapshot!='{}'`).bind(new Date(now).toISOString()).run();
}
