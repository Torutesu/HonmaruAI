// Workspace-scoped, named external collaborator grants. These grants are an
// additional resource boundary; they do not create a workspace membership and
// do not grant a guest access to rooms, files, Apps, or threads by themselves.

const RESOURCE_TYPES = new Set(["workspace", "room", "thread", "app", "file"]);
const PERMISSIONS = new Set(["view", "edit"]);

function clean(value, label) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 200) throw new TypeError(`Invalid ${label}`);
  return result;
}

function normalizeGrant(input) {
  const orgId = clean(input?.orgId, "workspace");
  const resourceType = clean(input?.resourceType, "resource type");
  const resourceId = clean(input?.resourceId, "resource");
  const recipientId = clean(input?.recipientGithubId, "recipient");
  const grantedBy = clean(input?.grantedBy, "grantor");
  const permission = clean(input?.permission, "permission");
  if (!RESOURCE_TYPES.has(resourceType)) throw new TypeError("Unsupported external resource type");
  if (!PERMISSIONS.has(permission)) throw new TypeError("Unsupported external permission");
  if (resourceType === "workspace" && resourceId !== orgId) {
    throw new TypeError("Workspace grants must target their own workspace");
  }
  let expiresAt = input?.expiresAt == null ? null : clean(input.expiresAt, "expiry");
  if (expiresAt != null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw new TypeError("Expiry must be a future timestamp");
  }
  return { orgId, resourceType, resourceId, recipientId, grantedBy, permission, expiresAt };
}

/**
 * Grant a pre-existing signed-in identity view/edit on one exact resource.
 * The identity remains outside the workspace membership table. Revoking a
 * previous grant and inserting the replacement are a single D1 batch so the
 * active-grant uniqueness constraint is safe under concurrent updates.
 */
export async function grantExternalResource(db, input, now = new Date().toISOString()) {
  const grant = normalizeGrant(input);
  const id = `xg_${crypto.randomUUID().replaceAll("-", "")}`;
  const revokePrevious = db.prepare(
    `UPDATE hx_external_resource_grants
        SET revoked_at = ?1, revoked_by = ?2
      WHERE org_id = ?3 AND resource_type = ?4 AND resource_id = ?5
        AND recipient_github_id = ?6 AND revoked_at IS NULL`
  ).bind(now, grant.grantedBy, grant.orgId, grant.resourceType, grant.resourceId, grant.recipientId);
  const insert = db.prepare(
    `INSERT INTO hx_external_resource_grants
      (id, org_id, resource_type, resource_id, recipient_github_id, permission,
       granted_by, granted_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(id, grant.orgId, grant.resourceType, grant.resourceId, grant.recipientId,
    grant.permission, grant.grantedBy, now, grant.expiresAt);
  await db.batch([revokePrevious, insert]);
  return { id, ...grant, grantedAt: now, revokedAt: null };
}

/**
 * Return an exact resource grant for a human collaborator. This is only one
 * input to a route's authorization decision: room membership, resource
 * existence, owner approval, and workspace deletion checks remain mandatory.
 */
export async function externalResourcePermission(db, {
  orgId, resourceType, resourceId, githubId, principalType = "human", now = new Date().toISOString(),
}) {
  if (principalType !== "human") return null;
  let scope;
  try {
    scope = normalizeGrant({ orgId, resourceType, resourceId, recipientGithubId: githubId,
      grantedBy: githubId, permission: "view" });
  } catch {
    return null;
  }
  const row = await db.prepare(
    `SELECT permission FROM hx_external_resource_grants
      WHERE org_id = ?1 AND resource_type = ?2 AND resource_id = ?3
        AND recipient_github_id = ?4 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?5)
      ORDER BY granted_at DESC LIMIT 1`
  ).bind(scope.orgId, scope.resourceType, scope.resourceId, scope.recipientId, now).first();
  return PERMISSIONS.has(String(row?.permission || "")) ? row.permission : null;
}

/** Immediately revoke a grant while retaining its audit record. */
export async function revokeExternalResource(db, { orgId, resourceType, resourceId, recipientGithubId, revokedBy }, now = new Date().toISOString()) {
  const scope = normalizeGrant({ orgId, resourceType, resourceId, recipientGithubId,
    grantedBy: revokedBy, permission: "view" });
  const result = await db.prepare(
    `UPDATE hx_external_resource_grants
        SET revoked_at = ?1, revoked_by = ?2
      WHERE org_id = ?3 AND resource_type = ?4 AND resource_id = ?5
        AND recipient_github_id = ?6 AND revoked_at IS NULL`
  ).bind(now, scope.grantedBy, scope.orgId, scope.resourceType, scope.resourceId, scope.recipientId).run();
  return Number(result?.meta?.changes || 0);
}

export const EXTERNAL_RESOURCE_TYPES = Object.freeze([...RESOURCE_TYPES]);
export const EXTERNAL_RESOURCE_PERMISSIONS = Object.freeze([...PERMISSIONS]);
