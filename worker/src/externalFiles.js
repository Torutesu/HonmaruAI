import { createHash } from "node:crypto";
import { getSession, getUserByGithubId } from "./db.js";
import { getMode } from "./harness/mode.js";

// External File access is intentionally a separate, exact-resource read path.
// It never accepts a scope, directory, search, cursor, or write command.
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "private, no-store" },
});
const fail = (message = "File not found.", status = 404) => json({ message }, status);
const PAGE_MAX = 100;
const FILE_MAX = 25 * 1024 * 1024;

function safeDisplayFilename(path) {
  const basename = String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || "shared-file";
  return basename.normalize("NFC").replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 180).trim() || "shared-file";
}


function fileParts(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "external" || parts[1] !== "files") return null;
  try {
    const orgId = decodeURIComponent(parts[2]);
    const fileId = decodeURIComponent(parts[3]);
    if (!orgId || orgId.length > 200 || !fileId || fileId.length > 200) return null;
    return { parts, orgId, fileId };
  } catch {
    return null;
  }
}

async function actorFor(request, db) {
  const session = await getSession(db, request.headers.get("x-session-token"));
  if (!session) return null;
  const user = await getUserByGithubId(db, session.github_id);
  return user ? { session, user } : null;
}

const liveWorkspace = `NOT EXISTS (
  SELECT 1 FROM workspace_deletions d
   WHERE d.org_id = f.org_id AND d.purge_started_at IS NOT NULL
) AND NOT EXISTS (
  SELECT 1 FROM workspace_tombstones t WHERE t.org_id = f.org_id
)`;
const liveScope = `NOT EXISTS (
  SELECT 1 FROM hx_room_access removed
   WHERE removed.org_id = f.org_id AND removed.channel = f.scope AND removed.deleted_at IS NOT NULL
) AND (
  substr(f.scope, 1, 2) != 'b:'
  OR EXISTS (SELECT 1 FROM businesses b
    WHERE b.org_id = f.org_id AND 'b:' || b.slug = f.scope AND b.archived_at IS NULL)
)`;
const currentFile = `EXISTS (
  SELECT 1 FROM hx_workspace_file_versions current
   WHERE current.org_id = f.org_id AND current.file_id = f.id
     AND current.version = f.current_version AND current.kind = 'content'
     AND NOT EXISTS (SELECT 1 FROM hx_workspace_file_purges purged
       WHERE purged.org_id = current.org_id AND purged.file_id = current.file_id
         AND purged.version = current.version)
)`;

async function readableFile(db, orgId, fileId, userId, now = new Date().toISOString()) {
  return db.prepare(`SELECT f.id, f.scope, f.path, f.created_by, f.created_at, f.updated_at,
      f.current_version, v.content_type, v.size, g.permission
    FROM hx_workspace_files f
    JOIN hx_workspace_file_versions v
      ON v.org_id = f.org_id AND v.file_id = f.id AND v.version = f.current_version
    JOIN hx_external_resource_grants g
      ON g.org_id = f.org_id AND g.resource_type = 'file' AND g.resource_id = f.id
     AND g.recipient_github_id = ?3 AND g.revoked_at IS NULL
     AND (g.expires_at IS NULL OR g.expires_at > ?4)
     AND EXISTS(SELECT 1 FROM users verified WHERE verified.github_id=g.recipient_github_id AND verified.email_verified_at IS NOT NULL)
    WHERE f.org_id = ?1 AND f.id = ?2 AND v.kind = 'content'
      AND NOT EXISTS (SELECT 1 FROM memberships member
        WHERE member.org_id = f.org_id AND member.user_github_id = ?3)
      AND ${liveWorkspace} AND ${liveScope} AND ${currentFile}
      AND NOT EXISTS (SELECT 1 FROM hx_workspace_file_purges purged
        WHERE purged.org_id = v.org_id AND purged.file_id = v.file_id
          AND purged.version = v.version)`)
    .bind(orgId, fileId, userId, now).first();
}

async function listVersions(db, orgId, fileId, userId, before, limit, now) {
  const rows = await db.prepare(`SELECT v.version, v.kind, v.content_type, v.size,
      v.created_at, v.restored_from, f.current_version,
      v.version = f.current_version AS is_current,
      purged.version IS NOT NULL AS purged
    FROM hx_workspace_files f
    JOIN hx_workspace_file_versions v ON v.org_id = f.org_id AND v.file_id = f.id
    JOIN hx_external_resource_grants g
      ON g.org_id = f.org_id AND g.resource_type = 'file' AND g.resource_id = f.id
     AND g.recipient_github_id = ?3 AND g.revoked_at IS NULL
     AND (g.expires_at IS NULL OR g.expires_at > ?4)
    LEFT JOIN hx_workspace_file_purges purged
      ON purged.org_id = v.org_id AND purged.file_id = v.file_id AND purged.version = v.version
    WHERE f.org_id = ?1 AND f.id = ?2 AND ( ?5 IS NULL OR v.version < ?5 )
      AND NOT EXISTS (SELECT 1 FROM memberships member
        WHERE member.org_id = f.org_id AND member.user_github_id = ?3)
      AND ${liveWorkspace} AND ${liveScope} AND ${currentFile}
      AND NOT EXISTS (SELECT 1 FROM hx_workspace_file_purges current_purge
        WHERE current_purge.org_id = f.org_id AND current_purge.file_id = f.id
          AND current_purge.version = f.current_version)
    ORDER BY v.version DESC LIMIT ?6`)
    .bind(orgId, fileId, userId, now, before, limit + 1).all();
  return rows.results || [];
}

async function contentSource(db, orgId, fileId, userId, version, now) {
  return db.prepare(`SELECT v.version, v.object_key, v.content_hash, v.content_type, v.size
    FROM hx_workspace_files f
    JOIN hx_workspace_file_versions v ON v.org_id = f.org_id AND v.file_id = f.id
    JOIN hx_external_resource_grants g
      ON g.org_id = f.org_id AND g.resource_type = 'file' AND g.resource_id = f.id
     AND g.recipient_github_id = ?3 AND g.revoked_at IS NULL
     AND (g.expires_at IS NULL OR g.expires_at > ?5)
    WHERE f.org_id = ?1 AND f.id = ?2 AND v.version = ?4 AND v.kind = 'content'
      AND NOT EXISTS (SELECT 1 FROM memberships member
        WHERE member.org_id = f.org_id AND member.user_github_id = ?3)
      AND ${liveWorkspace} AND ${liveScope} AND ${currentFile}
      AND NOT EXISTS (SELECT 1 FROM hx_workspace_file_purges purged
        WHERE purged.org_id = v.org_id AND purged.file_id = v.file_id
          AND purged.version = v.version)`)
    .bind(orgId, fileId, userId, version, now).first();
}

function validContentType(value) {
  return typeof value === "string" && value.length <= 128
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value);
}

async function downloadVersion(env, orgId, fileId, userId, version) {
  const now = new Date().toISOString();
  const source = await contentSource(env.DB, orgId, fileId, userId, version, now);
  const objectPrefix = `org/${encodeURIComponent(orgId)}/workspace-files/`;
  if (!source || !validContentType(source.content_type)
      || !Number.isSafeInteger(source.size) || source.size < 0 || source.size > FILE_MAX
      || typeof source.object_key !== "string" || !source.object_key.startsWith(objectPrefix)
      || source.object_key.length <= objectPrefix.length
      || !/^[a-f0-9]{64}$/.test(source.content_hash || "")) return null;
  let bytes;
  try {
    const object = await env.MEDIA.get(source.object_key);
    if (!object) return null;
    if (object.size !== source.size) {
      await object.body.cancel().catch(() => {});
      return null;
    }
    bytes = await object.arrayBuffer();
    if (bytes.byteLength !== source.size
        || createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== source.content_hash) return null;
  } catch {
    // Do not reveal object-storage errors or internal keys to an external reader.
    return null;
  }
  // Recheck access after the R2 read. A revoked or expired grant never returns
  // bytes merely because the request began while the grant was active.
  const current = await contentSource(env.DB, orgId, fileId, userId, version, new Date().toISOString());
  if (!current || current.object_key !== source.object_key || current.content_hash !== source.content_hash) return null;
  return new Response(bytes, {
    headers: {
      "content-type": source.content_type,
      "content-length": String(source.size),
      "content-disposition": `attachment; filename="file-v${source.version}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export async function handleExternalFiles(request, env, url) {
  if (!url.pathname.startsWith("/external/files/")) return null;
  if (request.method !== "GET") return fail("Method not allowed.", 405);
  const parsed = fileParts(url);
  if (!parsed) return fail();
  const { parts, orgId, fileId } = parsed;
  if (parts.length !== 4 && !(parts.length === 5 && parts[4] === "versions")
      && !(parts.length === 7 && parts[4] === "versions" && parts[6] === "content")) return fail();
  if (await getMode(env.DB, orgId) !== "harness") return fail("External File sharing is unavailable in Simple mode.");
  const actor = await actorFor(request, env.DB);
  if (!actor) return fail("Sign in to continue.", 401);
  const now = new Date().toISOString();

  if (parts.length === 4) {
    const file = await readableFile(env.DB, orgId, fileId, actor.user.github_id, now);
    return file ? json({ permission: file.permission, file: {
      id: file.id, path: safeDisplayFilename(file.path),
      createdAt: file.created_at, updatedAt: file.updated_at, version: file.current_version,
      contentType: file.content_type, size: file.size, deleted: false,
    } }) : fail();
  }
  if (parts.length === 5) {
    const beforeValue = url.searchParams.get("before");
    const limitValue = url.searchParams.get("limit");
    const before = beforeValue === null ? null : Number(beforeValue);
    const limit = limitValue === null ? 50 : Number(limitValue);
    if ((beforeValue !== null && (!/^[1-9]\d*$/.test(beforeValue) || !Number.isSafeInteger(before)))
        || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) return fail("Invalid version page.", 400);
    const file = await readableFile(env.DB, orgId, fileId, actor.user.github_id, now);
    if (!file) return fail();
    const rows = await listVersions(env.DB, orgId, fileId, actor.user.github_id, before, limit, now);
    const page = rows.slice(0, limit).map(row => ({
      version: row.version, kind: row.kind, contentType: row.content_type, size: row.size,
      createdAt: row.created_at, restoredFrom: row.restored_from,
      currentVersion: row.current_version, isCurrent: Boolean(row.is_current), purged: Boolean(row.purged),
    }));
    return json({ permission: file.permission, versions: page,
      nextBefore: rows.length > limit ? page.at(-1)?.version ?? null : null });
  }
  let version;
  try { version = decodeURIComponent(parts[5]); } catch { return fail(); }
  if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version))) return fail("Invalid file version.", 400);
  const response = await downloadVersion(env, orgId, fileId, actor.user.github_id, Number(version));
  return response || fail("File content is unavailable.");
}
