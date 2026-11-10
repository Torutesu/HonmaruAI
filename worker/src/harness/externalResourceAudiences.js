import { externalResourcePermission } from "./externalCollaborators.js";

const resourceTypes = new Set(["file", "app"]);
const audienceTypes = new Set(["workspace", "room"]);
const permissions = new Set(["view", "edit"]);

export function cleanResourceAudienceInput(input) {
  if (!input || !Number.isSafeInteger(input.version) || input.version < 0) {
    throw new TypeError("A valid audience version is required.");
  }
  if (input.type == null) return { version: input.version, type: null, roomId: null, permission: null, expiresAt: null };
  if (!audienceTypes.has(input.type)) throw new TypeError("Audience type must be workspace, room, or null.");
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
  return { version: input.version, type: input.type, roomId, permission,
    expiresAt: expiresAt == null ? null : new Date(expiresAt).toISOString() };
}

// Expressions are generated only by server code. Room and workspace access is
// live: every query checks current workspace and Room membership.
export function resourceAudienceAccessSql({ resourceType, org, resource, user, now,
  requiredPermission = null, audienceVersion = null, audienceOnly = false }) {
  if (!resourceTypes.has(resourceType)) throw new TypeError("Unsupported audience resource type.");
  if (requiredPermission != null && !permissions.has(requiredPermission)) throw new TypeError("Invalid resource permission.");
  const directPermission = requiredPermission ? ` AND g.permission='${requiredPermission}'` : "";
  const groupPermission = requiredPermission ? ` AND a.permission='${requiredPermission}'` : "";
  const versionFence = audienceVersion == null ? "" : ` AND a.version=${Number(audienceVersion)}`;
  const direct = audienceOnly ? "" :
    `EXISTS(SELECT 1 FROM hx_external_resource_grants g JOIN users identity ON identity.github_id=g.recipient_github_id
      WHERE g.org_id=${org} AND g.resource_type='${resourceType}' AND g.resource_id=${resource}
        AND g.recipient_github_id=${user} AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>${now})${directPermission}
        AND identity.email_verified_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM memberships currentMember WHERE currentMember.org_id=g.org_id
          AND currentMember.user_github_id=g.recipient_github_id))`;
  const audience = `EXISTS(SELECT 1 FROM hx_external_resource_audiences a
      JOIN memberships member ON member.org_id=a.org_id AND member.user_github_id=${user}
      WHERE a.org_id=${org} AND a.resource_type='${resourceType}' AND a.resource_id=${resource}
        AND a.audience_type IS NOT NULL AND (a.expires_at IS NULL OR a.expires_at>${now})${versionFence}${groupPermission}
        AND (a.audience_type='workspace' OR (a.audience_type='room' AND EXISTS(
          SELECT 1 /* org_id scope */ FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login
          WHERE cm.org_id=a.org_id AND cm.channel=a.room_id AND roomUser.github_id=${user}))))`;
  return `(${direct ? `${direct} OR ` : ""}${audience})`;
}

export function resourceAudiencePermissionSql({ resourceType, org, resource, user, now }) {
  const edit = resourceAudienceAccessSql({ resourceType, org, resource, user, now, requiredPermission: "edit" });
  const view = resourceAudienceAccessSql({ resourceType, org, resource, user, now, requiredPermission: "view" });
  return `CASE WHEN ${edit} THEN 'edit' WHEN ${view} THEN 'view' ELSE NULL END`;
}

export async function resourceAudiencePermission(db, { orgId, resourceType, resourceId, githubId,
  now = new Date().toISOString() }) {
  if (!resourceTypes.has(resourceType)) return null;
  const direct = await externalResourcePermission(db, { orgId, resourceType, resourceId, githubId, now });
  const row = await db.prepare(`SELECT a.permission,a.version FROM hx_external_resource_audiences a /* org_id scope */
    JOIN memberships member ON member.org_id=a.org_id AND member.user_github_id=?4
    WHERE a.org_id=?1 AND a.resource_type=?2 AND a.resource_id=?3 AND a.audience_type IS NOT NULL
      AND (a.expires_at IS NULL OR a.expires_at>?5)
      AND (a.audience_type='workspace' OR (a.audience_type='room' AND EXISTS(
        SELECT 1 /* org_id scope */ FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login
        WHERE cm.org_id=a.org_id AND cm.channel=a.room_id AND roomUser.github_id=?4))) LIMIT 1`)
    .bind(orgId, resourceType, resourceId, String(githubId), now).first();
  const groupPermission = row && permissions.has(String(row.permission)) ? row.permission : null;
  const permission = direct === "edit" || groupPermission === "edit" ? "edit"
    : direct === "view" || groupPermission === "view" ? "view" : null;
  if (!permission) return null;
  const audienceWins = groupPermission === permission && (direct !== "edit" || permission === "edit");
  return { permission, audienceVersion: audienceWins ? Number(row.version) : null,
    source: audienceWins ? "audience" : "grant" };
}

export async function listResourceAudienceRooms(db, orgId, userId) {
  const { results = [] } = await db.prepare(`SELECT 'b:'||b.slug AS id,b.name /* org_id scope */
    FROM businesses b JOIN memberships member ON member.org_id=b.org_id AND member.user_github_id=?2
    LEFT JOIN users roomUser ON roomUser.github_id=?2
    WHERE b.org_id=?1 AND b.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=b.org_id
        AND tombstone.channel='b:'||b.slug AND tombstone.deleted_at IS NOT NULL)
      AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.org_id=b.org_id
        AND cm.channel='b:'||b.slug AND cm.login=roomUser.login))
    ORDER BY b.name COLLATE NOCASE,b.slug`).bind(orgId, String(userId)).all();
  return results.map(({ id, name }) => ({ id, name: String(name || id) }));
}

export async function readResourceAudience(db, { orgId, resourceType, resourceId, userId,
  now = new Date().toISOString() }) {
  if (!resourceTypes.has(resourceType)) throw new TypeError("Unsupported audience resource type.");
  const row = await db.prepare(`SELECT version,audience_type,room_id,permission,expires_at /* org_id scope */
    FROM hx_external_resource_audiences WHERE org_id=?1 AND resource_type=?2 AND resource_id=?3`)
    .bind(orgId, resourceType, resourceId).first();
  const version = Number(row?.version || 0);
  const audience = row?.audience_type && (!row.expires_at || row.expires_at > now) ? {
    type: row.audience_type, ...(row.audience_type === "room" ? { roomId: row.room_id } : {}),
    permission: row.permission, expiresAt: row.expires_at || null, version,
  } : null;
  return { audience, version, rooms: await listResourceAudienceRooms(db, orgId, userId) };
}

export async function writeResourceAudience(db, { orgId, resourceType, resourceId, actorId,
  audience, managerFence, now = new Date().toISOString() }) {
  if (!resourceTypes.has(resourceType)) throw new TypeError("Unsupported audience resource type.");
  const version = audience.version + 1;
  const changeToken = "xrad_" + crypto.randomUUID().replaceAll("-", "");
  const insertFence = managerFence(12), updateFence = managerFence(13);
  const [inserted, updated] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_external_resource_audiences /* org_id scope */
      (org_id,resource_type,resource_id,version,audience_type,room_id,permission,expires_at,updated_by,updated_at,change_token)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
      WHERE ?4=1 AND NOT EXISTS(SELECT 1 FROM hx_external_resource_audiences current
        WHERE current.org_id=?1 AND current.resource_type=?2 AND current.resource_id=?3) AND ${insertFence.sql}`)
      .bind(orgId,resourceType,resourceId,version,audience.type,audience.roomId,audience.permission,audience.expiresAt,actorId,now,changeToken,...insertFence.bindings),
    db.prepare(`UPDATE hx_external_resource_audiences /* org_id scope */
      SET version=?1,audience_type=?2,room_id=?3,permission=?4,expires_at=?5,updated_by=?6,updated_at=?7,change_token=?8
      WHERE org_id=?9 AND resource_type=?10 AND resource_id=?11 AND version=?12 AND ${updateFence.sql}`)
      .bind(version,audience.type,audience.roomId,audience.permission,audience.expiresAt,actorId,now,changeToken,orgId,resourceType,resourceId,audience.version,...updateFence.bindings),
  ]);
  return Number(inserted?.meta?.changes || 0) + Number(updated?.meta?.changes || 0) > 0
    ? { version, changeToken } : null;
}
