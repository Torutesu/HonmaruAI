// The media origin (media.honmaruai.com): files, by signed address, from R2.
//
// Its own domain, so a file somebody uploaded can never run as a page on the
// API's origin, and its own Worker, which reads no database: the address
// says whose file it is, what it is and what it is called, and the signature
// (mediaToken.js) says the API meant it. An address that is forged, altered
// or out of its window gets the same 404 as a file that is not there.
//
// Pictures, video, audio and plain text are shown; everything else is a
// download. Range requests are answered, so a video plays and seeks.
// Deployed with wrangler.media.toml; needs the MEDIA bucket and the
// MEDIA_SIGNING_KEYS secret the API signs with.

import { verifyFileUrl } from "./mediaToken.js";
import { fileKey, byteRange, UNSATISFIABLE, isShown } from "./files.js";

const legacyKey = (id) => `file-${id}`;

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });

export async function serveMedia(request, env, now = Date.now()) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": "range" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const file = await verifyFileUrl(env, url, now);
  if (!file || !env.MEDIA) return notFound();
  const head = await env.MEDIA.head(fileKey(file.orgId, file.id)) || await env.MEDIA.head(legacyKey(file.id));
  if (!head) return notFound();
  const size = head.size;
  const shown = isShown(file.type);
  const saving = url.searchParams.get("download") === "1";
  const encoded = encodeURIComponent(file.name || "file").replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    "content-type": shown ? (file.type === "text/plain" ? "text/plain; charset=utf-8" : file.type) : "application/octet-stream",
    "content-disposition": `${shown && !saving ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
    "accept-ranges": "bytes",
    etag: head.httpEtag,
    // Kept by whoever fetched it until its address runs out, never by a
    // cache in between (§5.5).
    "cache-control": `private, max-age=${Math.max(0, Math.floor((file.expiresAt - now) / 1000))}`,
  };
  if (request.headers.get("if-none-match") === head.httpEtag) return new Response(null, { status: 304, headers });
  const ifRange = request.headers.get("if-range");
  const range = ifRange && ifRange !== head.httpEtag ? null : byteRange(request.headers.get("range"), size);
  if (range === UNSATISFIABLE) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  const out = {
    ...headers,
    "content-length": String(range ? range.length : size),
    ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` } : {}),
  };
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers: out });
  const obj = await env.MEDIA.get(head.key, range ? { range } : undefined);
  if (!obj) return notFound();
  return new Response(obj.body, { status: range ? 206 : 200, headers: out });
}

export default {
  fetch: (request, env) => serveMedia(request, env),
};
