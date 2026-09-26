// A workspace's own emoji: `:shogun_party:` in a message or as a reaction,
// drawn from a picture somebody in that workspace added. Only that
// workspace has them — another workspace's `:shogun_party:` is just text.
//
// Anyone in the workspace may add one (Slack's default); whoever added it,
// or an admin, may take it away. The bytes live in R2 under an unguessable
// id, served from this origin the way a workspace's logo is: the id is only
// ever handed to members, in the workspace's list.
//
// PNG, GIF, WebP and JPEG as they come. SVG too, because a crisp animated
// mark is what a team's own emoji often is — but only an SVG that is a
// picture and nothing else: every element on a short list of shapes,
// styles and animations, no script, no handler, nothing fetched from
// anywhere, no link that leaves the file. One that is anything more is
// refused, not cleaned. And it is served with a policy that runs nothing,
// so even opened on its own it is only drawn.

const MAX_BYTES = 512 * 1024;
const MAX_PER_ORG = 500;
const PREFIX = "emoji-";
const TYPES = new Set(["image/png", "image/gif", "image/webp", "image/jpeg", "image/svg+xml"]);
export const EMOJI_NAME = /^[a-z0-9_+-]{1,30}$/;

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

/// A name as typed, or a file's name, made into an emoji's name: lower
/// case, the separators an emoji name has, no colons. Null if nothing is
/// left.
export function cleanEmojiName(raw) {
  const name = String(raw || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^:+|:+$/g, "")
    .toLowerCase()
    .replace(/[\s.]+/g, "_")
    .replace(/[^a-z0-9_+-]/g, "")
    .slice(0, 30);
  return EMOJI_NAME.test(name) ? name : null;
}

const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "title", "desc", "style", "defs", "symbol", "use", "clippath", "mask",
  "lineargradient", "radialgradient", "stop", "pattern", "text", "tspan",
  "animate", "animatetransform", "animatemotion", "mpath", "set",
  "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "fecomposite",
  "feflood", "femerge", "femergenode", "fedropshadow", "femorphology",
]);

/// Whether this SVG is a picture and nothing else. Returns the reason it
/// is not, or null.
export function svgProblem(text) {
  const src = String(text || "");
  if (!/<svg[\s>]/i.test(src)) return "That is not an SVG.";
  if (/<!(DOCTYPE|ENTITY)/i.test(src)) return "An SVG with a DOCTYPE or entities is not accepted.";
  if (/<!\[CDATA\[/i.test(src)) return "An SVG with CDATA is not accepted.";
  for (const m of src.matchAll(/<\s*([a-zA-Z][\w:.-]*)/g)) {
    const tag = m[1].toLowerCase();
    if (!SVG_ELEMENTS.has(tag)) return `An emoji SVG may not contain <${m[1]}>.`;
  }
  // Processing instructions other than the XML declaration.
  for (const m of src.matchAll(/<\?\s*([\w-]+)/g)) if (m[1].toLowerCase() !== "xml") return "That SVG has an instruction in it.";
  if (/\son[a-z]+\s*=/i.test(src)) return "An emoji SVG may not have event handlers.";
  if (/javascript:|vbscript:|data:text\/html/i.test(src)) return "An emoji SVG may not have script.";
  if (/@import/i.test(src)) return "An emoji SVG may not import styles.";
  // Every link and every url() stays inside the file.
  for (const m of src.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) if (!m[2].trim().startsWith("#")) return "An emoji SVG may only link inside itself.";
  for (const m of src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (!m[2].trim().startsWith("#")) return "An emoji SVG may not load anything.";
  // An animation that rewrites a link or a handler is the same thing, later.
  if (/attributeName\s*=\s*(["'])\s*(?:xlink:)?(?:href|on\w+)\s*\1/i.test(src)) return "An emoji SVG may not animate a link.";
  return null;
}

const toEmoji = (origin, row) => ({
  name: row.name,
  url: `${origin}/emoji/img/${row.media_id}`,
  by: row.created_by || null,
  createdAt: row.created_at,
});

/// This workspace's emoji, by name.
export async function listEmoji(db, orgId, origin) {
  const { results } = await db.prepare(
    "SELECT name, media_id, created_by, created_at FROM org_emoji WHERE org_id = ?1 ORDER BY name"
  ).bind(orgId).all();
  return (results || []).map((row) => toEmoji(origin, row));
}

/// Whether `:name:` is one of this workspace's.
export async function hasEmoji(db, orgId, name) {
  return Boolean(await db.prepare("SELECT 1 FROM org_emoji WHERE org_id = ?1 AND name = ?2").bind(orgId, name).first());
}

/// The picture on the request, added as `:name:`. Returns the emoji or
/// `{ error, status }`.
export async function addEmoji(request, env, { orgId, login, name: rawName, origin }) {
  const name = cleanEmojiName(rawName);
  if (!name) return { error: "A name is letters, numbers, - _ and +, up to 30.", status: 400 };
  const contentType = bare(request.headers.get("content-type"));
  if (!TYPES.has(contentType)) return { error: "An emoji is a PNG, GIF, WebP, JPEG or SVG.", status: 415 };
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) return { error: "An emoji is at most 512 KB.", status: 413 };
  if (!request.body) return { error: "No picture in the request.", status: 400 };
  const bytes = await readCapped(request.body, MAX_BYTES);
  if (!bytes) return { error: "An emoji is at most 512 KB.", status: 413 };
  if (!bytes.byteLength) return { error: "No picture in the request.", status: 400 };
  if (contentType === "image/svg+xml") {
    const problem = svgProblem(new TextDecoder().decode(bytes));
    if (problem) return { error: problem, status: 400 };
  }
  if (await hasEmoji(env.DB, orgId, name)) return { error: `:${name}: is already one of this workspace's emoji.`, status: 409 };
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_emoji WHERE org_id = ?1").bind(orgId).first();
  if ((count?.n || 0) >= MAX_PER_ORG) return { error: "This workspace has all the emoji it can hold.", status: 400 };
  const mediaId = PREFIX + crypto.randomUUID();
  await env.MEDIA.put(mediaId, bytes, { httpMetadata: { contentType } });
  const at = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO org_emoji (org_id, name, media_id, content_type, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(orgId, name, mediaId, contentType, login, at).run();
  // Two people adding the same name at once: the first keeps it.
  if (!(res?.meta?.changes > 0)) {
    await env.MEDIA.delete(mediaId).catch(() => {});
    return { error: `:${name}: is already one of this workspace's emoji.`, status: 409 };
  }
  return { emoji: toEmoji(origin, { name, media_id: mediaId, created_by: login, created_at: at }) };
}

/// Take one away: whoever added it, or an admin.
export async function removeEmoji(env, { orgId, name, login, isAdmin }) {
  const row = await env.DB.prepare("SELECT media_id, created_by FROM org_emoji WHERE org_id = ?1 AND name = ?2").bind(orgId, name).first();
  if (!row) return { error: "No such emoji.", status: 404 };
  if (row.created_by !== login && !isAdmin) return { error: "Only whoever added it, or an admin, can remove it.", status: 403 };
  await env.DB.prepare("DELETE FROM org_emoji WHERE org_id = ?1 AND name = ?2").bind(orgId, name).run();
  await env.MEDIA.delete(row.media_id).catch(() => {});
  return { removed: name };
}

/// The bytes back, as a picture and nothing that runs.
export async function serveEmoji(mediaId, env) {
  if (!/^emoji-[0-9a-f-]{36}$/.test(String(mediaId))) return new Response("not found", { status: 404 });
  const object = await env.MEDIA.get(mediaId);
  if (!object) return new Response("not found", { status: 404 });
  const stored = bare(object.httpMetadata?.contentType);
  const contentType = TYPES.has(stored) ? stored : "application/octet-stream";
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
