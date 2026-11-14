import { externalResourcePermission } from "./externalCollaborators.js";

const types = new Set(["workspace", "room"]);
const permissions = new Set(["view", "edit"]);

export function cleanThreadAudienceInput(input) {
  if (!input || !Number.isSafeInteger(input.version) || input.version < 0) {
    throw new TypeError("A valid audience version is required.");
  }
  if (input.type == null) return { version: input.version, type: null, roomId: null, permission: null, expiresAt: null };
  if (!types.has(input.type)) throw new TypeError("Audience type must be workspace, room, or null.");
  if (!permissions.has(input.permission)) throw new TypeError("Permission must be view or edit.");
  const roomId = input.type === "room" ? String(input.roomId || "").trim() : null;
  if (input.type === "room" && (!roomId || roomId.length > 200 || !roomId.startsWith("b:"))) {
    throw new TypeError("Choose a Room in this workspace.");
  }
  if (input.type === "workspace" && input.roomId != null) throw new TypeError("Workspace audience cannot have a roomId.");
  const expiresAt = input.expiresAt == null ? null : String(input.expiresAt).trim();
  if (expiresAt != null && (!expiresAt || expiresAt.length > 200 ||
      !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw new TypeError("Expiry must be a future timestamp.");
  }
  return { version: input.version, type: input.type, roomId, permission: input.permission,
    expiresAt: expiresAt == null ? null : new Date(expiresAt).toISOString() };
}

export function threadAudienceAccessSql({ org, root, user, now, requiredPermission = null, audienceVersion = null, audienceOnly = false }) {
  const directPermission = requiredPermission ? " AND g.permission='" + requiredPermission + "'" : "";
  const groupPermission = requiredPermission ? " AND a.permission='" + requiredPermission + "'" : "";
  const versionFence = audienceVersion == null ? "" : " AND a.version=" + audienceVersion;
  const direct = audienceOnly ? "" :
    "EXISTS(SELECT 1 FROM hx_external_resource_grants g " +
    "WHERE g.org_id=" + org + " AND g.resource_type='thread' AND g.resource_id=" + root + " " +
    "AND g.recipient_github_id=" + user + " AND g.revoked_at IS NULL " +
    "AND (g.expires_at IS NULL OR g.expires_at>" + now + ")" + directPermission + " " +
    "AND NOT EXISTS(SELECT 1 FROM memberships member " +
    "WHERE member.org_id=g.org_id AND member.user_github_id=g.recipient_github_id))";
  return "(" + (direct ? direct + " OR " : "") + "EXISTS(SELECT 1 FROM hx_external_thread_audiences a " +
    "JOIN memberships member ON member.org_id=a.org_id AND member.user_github_id=" + user + " " +
    "WHERE a.org_id=" + org + " AND a.root_message_id=" + root + " " +
    "AND a.audience_type IS NOT NULL AND (a.expires_at IS NULL OR a.expires_at>" + now + ")" + versionFence +
    groupPermission + " AND (a.audience_type='workspace' OR (a.audience_type='room' AND EXISTS(" +
    "SELECT 1 /* org_id scope */ FROM businesses liveRoom WHERE liveRoom.org_id=a.org_id " +
    "AND 'b:'||liveRoom.slug=a.room_id AND liveRoom.archived_at IS NULL " +
    "AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM hx_room_access removedRoom " +
    "WHERE removedRoom.org_id=liveRoom.org_id AND removedRoom.channel=a.room_id AND removedRoom.deleted_at IS NOT NULL) " +
    "AND EXISTS(" +
    "SELECT 1 /* org_id scope */ FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login " +
    "WHERE cm.org_id=a.org_id AND cm.channel=a.room_id AND roomUser.github_id=" + user + ")))))" +
    ")";
}

export async function externalThreadPermission(db, { orgId, rootId, githubId, now = new Date().toISOString() }) {
  const direct = await externalResourcePermission(db, {
    orgId, resourceType: "thread", resourceId: rootId, githubId, now,
  });
  const row = await db.prepare("SELECT a.permission,a.version FROM hx_external_thread_audiences a /* org_id scope */ " +
    "JOIN memberships member ON member.org_id=a.org_id AND member.user_github_id=?3 " +
    "WHERE a.org_id=?1 AND a.root_message_id=?2 AND a.audience_type IS NOT NULL " +
    "AND (a.expires_at IS NULL OR a.expires_at>?4) AND " +
    "(a.audience_type='workspace' OR (a.audience_type='room' AND EXISTS(" +
    "SELECT 1 /* org_id scope */ FROM businesses liveRoom WHERE liveRoom.org_id=a.org_id " +
    "AND 'b:'||liveRoom.slug=a.room_id AND liveRoom.archived_at IS NULL " +
    "AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM hx_room_access removedRoom " +
    "WHERE removedRoom.org_id=liveRoom.org_id AND removedRoom.channel=a.room_id AND removedRoom.deleted_at IS NOT NULL) " +
    "AND EXISTS(" +
    "SELECT 1 /* org_id scope */ FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login " +
    "WHERE cm.org_id=a.org_id AND cm.channel=a.room_id AND roomUser.github_id=?3)))) LIMIT 1")
    .bind(orgId, rootId, String(githubId), now).first();
  const groupPermission = row && permissions.has(String(row.permission)) ? row.permission : null;
  const permission = direct === "edit" || groupPermission === "edit" ? "edit"
    : direct === "view" || groupPermission === "view" ? "view" : null;
  if (!permission) return null;
  const audienceWins = groupPermission === permission && (direct !== "edit" || permission === "edit");
  return { permission, audienceVersion: audienceWins ? Number(row.version) : null,
    source: audienceWins ? "audience" : "grant" };
}

export async function listThreadAudienceRooms(db, orgId, userId) {
  const { results = [] } = await db.prepare("SELECT 'b:'||b.slug AS id,b.name /* org_id scope */ " +
    "FROM businesses b JOIN memberships member ON member.org_id=b.org_id AND member.user_github_id=?2 " +
    "LEFT JOIN users roomUser ON roomUser.github_id=?2 " +
    "WHERE b.org_id=?1 AND b.archived_at IS NULL " +
    "AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=b.org_id " +
    "AND tombstone.channel='b:'||b.slug AND tombstone.deleted_at IS NOT NULL) " +
    "AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.org_id=b.org_id " +
    "AND cm.channel='b:'||b.slug AND cm.login=roomUser.login)) ORDER BY b.name COLLATE NOCASE,b.slug")
    .bind(orgId, String(userId)).all();
  return results.map(({ id, name }) => ({ id, name: String(name || id) }));
}

export async function readThreadAudience(db, { orgId, rootId, userId, now = new Date().toISOString() }) {
  const row = await db.prepare("SELECT version,audience_type,room_id,permission,expires_at " +
    "FROM hx_external_thread_audiences WHERE org_id=?1 AND root_message_id=?2")
    .bind(orgId, rootId).first();
  const version = Number(row?.version || 0);
  let audience = null;
  if (row?.audience_type && (!row.expires_at || row.expires_at > now)) {
    audience = {
      type: row.audience_type,
      ...(row.audience_type === "room" ? { roomId: row.room_id } : {}),
      permission: row.permission,
      expiresAt: row.expires_at || null,
      version,
    };
  }
  return { audience, version, rooms: await listThreadAudienceRooms(db, orgId, userId) };
}

export async function writeThreadAudience(db, { orgId, rootId, actorId, audience, managerFence, now = new Date().toISOString() }) {
  const version = audience.version + 1;
  const changeToken = "xaud_" + crypto.randomUUID().replaceAll("-", "");
  const insertFence = managerFence(11);
  const updateFence = managerFence(12);
  const [inserted, updated] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO hx_external_thread_audiences " +
      "(org_id,root_message_id,version,audience_type,room_id,permission,expires_at,updated_by,updated_at,change_token) " +
      "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 " +
      "WHERE ?3=1 AND NOT EXISTS(SELECT 1 FROM hx_external_thread_audiences " +
      "WHERE org_id=?1 AND root_message_id=?2) AND " + insertFence.sql)
      .bind(orgId,rootId,version,audience.type,audience.roomId,audience.permission,audience.expiresAt,actorId,now,changeToken,...insertFence.bindings),
    db.prepare("UPDATE hx_external_thread_audiences " +
      "SET version=?1,audience_type=?2,room_id=?3,permission=?4,expires_at=?5,updated_by=?6,updated_at=?7,change_token=?8 " +
      "WHERE org_id=?9 AND root_message_id=?10 AND version=?11 AND " + updateFence.sql)
      .bind(version,audience.type,audience.roomId,audience.permission,audience.expiresAt,actorId,now,changeToken,
        orgId,rootId,audience.version,...updateFence.bindings),
    db.prepare("UPDATE hx_external_thread_send_requests SET status='cancelled',decided_at=?1,decided_by=?2 " +
      "WHERE org_id=?3 AND root_message_id=?4 AND status='pending' AND EXISTS(" +
      "SELECT 1 FROM hx_external_thread_audience_requests requestAudience " +
      "WHERE requestAudience.request_id=hx_external_thread_send_requests.id AND requestAudience.audience_version=?5) " +
      "AND EXISTS(SELECT 1 FROM hx_external_thread_audiences a WHERE a.org_id=?3 " +
      "AND a.root_message_id=?4 AND a.version=?6 AND a.change_token=?7)")
      .bind(now,actorId,orgId,rootId,audience.version,version,changeToken),
  ]);
  const changes = Number(inserted?.meta?.changes || 0) + Number(updated?.meta?.changes || 0);
  return changes > 0 ? { version, changeToken } : null;
}
