// A workspace's own mark: the logo at the top of the rail and in the
// switcher, chosen by its admins. Bytes in R2 under an unguessable id (the
// same way a card's video is kept), the id in D1 against the workspace.
//
// Images only. The served object comes back from the Worker's own origin,
// so what this accepts is what this origin will serve: PNG, JPEG, WebP,
// GIF. No SVG — an SVG is a document that can run script.

const MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PREFIX = "org-icon-";

const bare = (header) => String(header || "").split(";")[0].trim().toLowerCase();

async function readCapped(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export const iconUrl = (origin, mediaId) => (mediaId ? `${origin}/orgs/icon/${mediaId}` : null);

export async function getOrgIcon(db, orgId) {
  const row = await db.prepare("SELECT media_id, content_type, updated_at FROM org_icons WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  return row?.media_id ? { mediaId: row.media_id, contentType: row.content_type, updatedAt: row.updated_at } : null;
}

/// The icons of several workspaces at once, for a list.
export async function iconsFor(db, orgIds) {
  const out = {};
  for (const id of orgIds) {
    const icon = await getOrgIcon(db, id);
    if (icon) out[id] = icon.mediaId;
  }
  return out;
}

/// Take the image on the request and make it the workspace's mark. Returns
/// `{ mediaId }` or `{ error, status }`.
export async function uploadOrgIcon(request, env, orgId) {
  const contentType = bare(request.headers.get("content-type"));
  if (!IMAGE_TYPES.has(contentType)) return { error: "A logo is a PNG, JPEG, WebP or GIF.", status: 415 };
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) return { error: "A logo is at most 2 MB.", status: 413 };
  if (!request.body) return { error: "No image in the request.", status: 400 };
  const bytes = await readCapped(request.body, MAX_BYTES);
  if (!bytes) return { error: "A logo is at most 2 MB.", status: 413 };
  if (bytes.byteLength === 0) return { error: "No image in the request.", status: 400 };
  const mediaId = PREFIX + crypto.randomUUID();
  await env.MEDIA.put(mediaId, bytes, { httpMetadata: { contentType } });
  const previous = await getOrgIcon(env.DB, orgId);
  await env.DB
    .prepare(
      `INSERT INTO org_icons (org_id, media_id, content_type, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(org_id) DO UPDATE SET media_id = excluded.media_id, content_type = excluded.content_type, updated_at = excluded.updated_at`
    )
    .bind(orgId, mediaId, contentType, new Date().toISOString())
    .run();
  if (previous?.mediaId) await env.MEDIA.delete(previous.mediaId).catch(() => {});
  return { mediaId };
}

export async function removeOrgIcon(env, orgId) {
  const previous = await getOrgIcon(env.DB, orgId);
  await env.DB.prepare("DELETE FROM org_icons WHERE org_id = ?1").bind(orgId).run();
  if (previous?.mediaId) await env.MEDIA.delete(previous.mediaId).catch(() => {});
}

/// The bytes back, as an image and nothing else.
export async function serveOrgIcon(mediaId, env) {
  if (!String(mediaId).startsWith(PREFIX)) return new Response("not found", { status: 404 });
  const object = await env.MEDIA.get(mediaId);
  if (!object) return new Response("not found", { status: 404 });
  const stored = bare(object.httpMetadata?.contentType);
  const contentType = IMAGE_TYPES.has(stored) ? stored : "application/octet-stream";
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}
