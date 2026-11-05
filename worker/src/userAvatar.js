import { getSession } from "./db.js";
import { enforce } from "./ratelimit.js";
import { authorizeAgentAvatar, inaccessibleAgentAvatar } from "./agentAvatarAccess.js";

// A person's own photo: the face beside everything they write, in every
// list, pane and call. A GitHub account arrives with one; anyone can upload
// their own, which then wins. Bytes in R2 under an unguessable id, the URL
// in users.avatar_url — the same column a GitHub avatar lives in, so every
// reader of it gets both.
//
// Images only, and never SVG: the object comes back from this origin, and
// an SVG is a document that can run script.

export const MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PREFIX = "user-avatar-";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS } });
}
export const bare = (header) => String(header || "").split(";")[0].trim().toLowerCase();

export async function readCapped(stream, max) {
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

/// The media id an avatar URL of ours points at, or null for anyone else's.
function ownMediaId(avatarUrl) {
  const m = /\/users\/avatar\/(user-avatar-[0-9a-f-]{36})$/.exec(String(avatarUrl || ""));
  return m ? m[1] : null;
}

/// The picture a request carries, checked: `{ bytes, contentType }`, or
/// `{ error, status }` saying what is wrong with it.
export async function readImage(request) {
  const contentType = bare(request.headers.get("content-type"));
  if (!IMAGE_TYPES.has(contentType)) return { error: "A photo is a PNG, JPEG, WebP or GIF.", status: 415 };
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) return { error: "A photo is at most 2 MB.", status: 413 };
  if (!request.body) return { error: "No image in the request.", status: 400 };
  const bytes = await readCapped(request.body, MAX_BYTES);
  if (!bytes) return { error: "A photo is at most 2 MB.", status: 413 };
  if (!bytes.byteLength) return { error: "No image in the request.", status: 400 };
  return { bytes, contentType };
}

/// POST /me/avatar (the image as the body) · DELETE /me/avatar ·
/// GET /users/avatar/:id, and an agent's picture: GET /agents/avatar/:id.
export async function handleUserAvatar(request, env, url) {
  const userAvatar = url.pathname.match(/^\/users\/avatar\/(user-avatar-[0-9a-f-]{36})$/);
  const agentAvatar = url.pathname.match(/^\/agents\/avatar\/(agent-avatar-[0-9a-f-]{36})$/);
  if ((userAvatar || agentAvatar) && request.method === "GET") {
    const agentAccess = agentAvatar ? await authorizeAgentAvatar(env, url, agentAvatar[1]) : null;
    if (agentAccess?.response) return agentAccess.response;
    const mediaId = userAvatar?.[1] || agentAvatar?.[1];
    const object = await env.MEDIA.get(mediaId);
    if (!object) return agentAvatar ? inaccessibleAgentAvatar() : new Response("not found", { status: 404 });
    const stored = bare(object.httpMetadata?.contentType);
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": IMAGE_TYPES.has(stored) ? stored : "application/octet-stream",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": agentAvatar ? "no-store" : "public, max-age=31536000, immutable",
        ...(!privateAgent ? { "access-control-allow-origin": "*" } : {}),
      },
    });
  }
  if (url.pathname !== "/me/avatar" || (request.method !== "POST" && request.method !== "DELETE")) return null;
  const limited = await enforce(env, request, "team");
  if (limited) return limited;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const current = await env.DB.prepare("SELECT avatar_url FROM users WHERE github_id = ?1").bind(String(session.github_id)).first();
  const previous = ownMediaId(current?.avatar_url);

  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE users SET avatar_url = NULL WHERE github_id = ?1").bind(String(session.github_id)).run();
    if (previous) await env.MEDIA.delete(previous).catch(() => {});
    return json({ avatarUrl: null });
  }

  const image = await readImage(request);
  if (image.error) return json({ message: image.error }, image.status);
  const { bytes, contentType } = image;
  const mediaId = `${PREFIX}${crypto.randomUUID()}`;
  await env.MEDIA.put(mediaId, bytes, { httpMetadata: { contentType } });
  const avatarUrl = `${url.origin}/users/avatar/${mediaId}`;
  await env.DB.prepare("UPDATE users SET avatar_url = ?1 WHERE github_id = ?2").bind(avatarUrl, String(session.github_id)).run();
  if (previous) await env.MEDIA.delete(previous).catch(() => {});
  return json({ avatarUrl });
}
