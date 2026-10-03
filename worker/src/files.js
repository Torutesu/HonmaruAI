// Files and pictures in a conversation.
//
// A file is uploaded into a conversation you can read, before the message
// that carries it is sent: the bytes go to R2 at once, the row waits with
// no message, and sending the message claims it. A file nobody sends is
// swept after a day.
//
// Who may fetch it is who may read the message. A browser shows a picture
// with <img src>, which cannot carry the session header, so the address a
// reader is given is signed: the file, and until when, under a key only the
// Worker holds. The key is made on first use and kept in D1, so a new
// deployment needs no new secret. An address is good for a day or two and
// the same all day — a picture is cached, not fetched on every scroll — and
// one that leaks stops working on its own.
//
// Only pictures, video, audio and plain text are served to be shown. Every
// other type — HTML, SVG, a PDF, an archive — is served as a download, as
// bytes, with a sandbox around it: this origin is the API's, and a file
// somebody uploaded must never run as a page on it.

import { promisedLength, peek, putExactly, looksLike, sniffing, HEAD_BYTES } from "./upload.js";
import { mediaEnv, mediaOriginOn, signFileUrl } from "./mediaToken.js";
import { accessFor, mayRead } from "./access.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
const ID = /^f_[0-9a-f]{24}$/;

const SHOWN = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm",
  // What Chrome and Safari call an .m4a (a phone's voice memo), and the
  // other names browsers give .aac, .flac and .wav.
  "audio/x-m4a", "audio/aac", "audio/flac", "audio/x-wav",
  "text/plain",
]);
/// Whether a file of this type is shown where it is opened, rather than
/// saved: the media origin's Worker asks the same question.
export const isShown = (type) => SHOWN.has(type);
export const isPicture = (type) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);
const isVideo = (type) => /^video\/(mp4|webm|quicktime)$/.test(type);

/// A file's name as it may be stored and shown: no path, no control
/// characters, not endless.
export function cleanName(raw) {
  const base = String(raw || "").split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return name || "file";
}

function bareType(header) {
  return String(header || "").split(";")[0].trim().toLowerCase() || "application/octet-stream";
}

// ---- Signing ----

const KEY_NAME = "file-signing-key";
let cachedKey = null;
async function signingKey(db) {
  if (cachedKey) return cachedKey;
  let row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(KEY_NAME).first();
  if (!row) {
    const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // Two first uses at once: one wins, and both read the winner.
    await db.prepare("INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)").bind(KEY_NAME, raw, new Date().toISOString()).run();
    row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(KEY_NAME).first();
  }
  cachedKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(row.value), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return cachedKey;
}

async function mac(db, id, until) {
  const sig = await crypto.subtle.sign("HMAC", await signingKey(db), new TextEncoder().encode(`${id}.${until}`));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// Until when an address made now is good: the end of tomorrow, UTC, so it
/// is the same address all day.
export function validUntil(now = Date.now()) {
  return (Math.floor(now / 86400000) + 2) * 86400;
}

/// The address a reader is given, relative to the API.
export async function signedPath(db, id, now = Date.now()) {
  const until = validUntil(now);
  return `/files/${id}?e=${until}&s=${await mac(db, id, until)}`;
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Rows ----

/// Where a reader fetches a file, and until when (ms): on the media
/// origin when it is on (mediaToken.js), else this API's own /files.
export async function fileAddress(db, row, now = Date.now(), env = mediaEnv()) {
  if (mediaOriginOn(env)) {
    const signed = await signFileUrl(env, { orgId: row.org_id, id: row.id, type: row.type, name: row.name }, now);
    if (signed) return signed;
  }
  return { url: await signedPath(db, row.id, now), expiresAt: validUntil(now) * 1000 };
}

/// A file as a browser sees it. `url` changes as it is renewed; `id` does
/// not, and is what a client keeps it by. `expiresAt` says when to ask for
/// a new address (POST /media/urls).
export async function toFile(db, row, now = Date.now()) {
  const { url, expiresAt } = await fileAddress(db, row, now);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: row.size,
    width: row.width || null,
    height: row.height || null,
    url,
    expiresAt,
  };
}

/// POST /media/urls — new addresses for files a client already shows, for
/// one whose address ran out. Only for files the caller could read now: in
/// a conversation they are in, sent, or theirs not yet sent.
export async function freshFileUrls(env, { orgId, login, ids }, now = Date.now()) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && ID.test(id)))].slice(0, 100);
  const out = {};
  if (!wanted.length) return out;
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM message_files WHERE org_id = ?1 AND id IN (${wanted.map((_, i) => `?${i + 2}`).join(", ")})`
  ).bind(orgId, ...wanted).all();
  const access = await accessFor(env.DB, orgId, login);
  for (const row of results) {
    if (!mayRead(row.channel, access)) continue;
    if (!row.message_id && row.uploader !== login) continue;
    out[row.id] = await fileAddress(env.DB, row, now, env);
  }
  return out;
}

/// The files on a page of messages, by message id.
export async function filesFor(db, orgId, messageIds) {
  const out = new Map();
  for (let i = 0; i < messageIds.length; i += 90) {
    const chunk = messageIds.slice(i, i + 90);
    if (!chunk.length) continue;
    const marks = chunk.map((_, j) => `?${j + 2}`).join(", ");
    const { results } = await db
      .prepare(`SELECT * FROM message_files WHERE org_id = ?1 AND message_id IN (${marks}) ORDER BY created_at, rowid`)
      .bind(orgId, ...chunk)
      .all();
    for (const r of results || []) {
      if (!out.has(r.message_id)) out.set(r.message_id, []);
      out.get(r.message_id).push(r);
    }
  }
  return out;
}

/// Claim uploads for a message just sent: only yours, only uploaded into
/// this conversation, only ones no message has yet.
export async function attachFiles(db, { orgId, key, login, messageId, ids }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && ID.test(x)))].slice(0, MAX_FILES_PER_MESSAGE);
  if (!wanted.length) return 0;
  const marks = wanted.map((_, j) => `?${j + 5}`).join(", ");
  const res = await db
    .prepare(`UPDATE message_files SET message_id = ?4
               WHERE org_id = ?1 AND channel = ?2 AND uploader = ?3 AND message_id IS NULL AND id IN (${marks})`)
    .bind(orgId, key, login, messageId, ...wanted)
    .run();
  return res.meta?.changes || 0;
}

/// Uploads that could be attached: yours, in this conversation, unsent.
export async function claimable(db, { orgId, key, login, ids }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && ID.test(x)))].slice(0, MAX_FILES_PER_MESSAGE);
  if (!wanted.length) return 0;
  const marks = wanted.map((_, j) => `?${j + 4}`).join(", ");
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM message_files WHERE org_id = ?1 AND channel = ?2 AND uploader = ?3 AND message_id IS NULL AND id IN (${marks})`)
    .bind(orgId, key, login, ...wanted)
    .first();
  return row?.n || 0;
}

// Where a file's bytes live: under its workspace, so a workspace's files can
// be listed, exported, moved or removed by prefix. Files stored before that
// are at `file-<id>` and are still read from there.
export const fileKey = (orgId, id) => `org/${encodeURIComponent(orgId)}/files/${id}`;
const legacyFileKey = (id) => `file-${id}`;

/// `options` are R2's own, as `{ range }` to read one span of the bytes.
export async function getFileObject(env, orgId, id, options) {
  if (!env.MEDIA) return null;
  return (await env.MEDIA.get(fileKey(orgId, id), options)) || env.MEDIA.get(legacyFileKey(id), options);
}

export async function deleteFileObject(env, orgId, id) {
  if (!env.MEDIA) return;
  await deleteMediaKeys(env, orgId, [fileKey(orgId, id), legacyFileKey(id)]);
}

// ---- Deleting that does not lose track ----
//
// A delete R2 refuses used to be swallowed, and the row went anyway: the
// bytes stayed in the bucket with nothing pointing at them — a file the
// person removed, kept and billed for, and never looked at again. Now a key
// whose delete failed is written down, and the cron tries it again with
// backoff until it goes (a key that is already gone deletes fine).

const DELETE_RETRY_MAX = 12;

/// Delete these keys; any R2 refuses is kept in `media_deletions` for later.
export async function deleteMediaKeys(env, orgId, keys) {
  const failed = [];
  await Promise.all(keys.map(async (key) => {
    try { await env.MEDIA.delete(key); } catch (err) { failed.push([key, String(err?.message || err).slice(0, 200)]); }
  }));
  for (const [key, error] of failed) {
    const now = new Date().toISOString();
    await env.DB
      .prepare(`INSERT INTO media_deletions (key, org_id, attempts, last_error, created_at, next_at)
                VALUES (?1, ?2, 0, ?3, ?4, ?4)
                ON CONFLICT(key) DO UPDATE SET last_error = excluded.last_error`)
      .bind(key, orgId || null, error, now)
      .run();
  }
  return failed.length;
}

/// The cron's pass over deletes that failed: due ones tried again, each
/// waiting twice as long as the last (1 minute up to a day). One that still
/// fails after DELETE_RETRY_MAX tries is logged as an error to be looked at.
export async function retryMediaDeletions(env, now = Date.now()) {
  if (!env.MEDIA) return { deleted: 0, failed: 0 };
  const { results } = await env.DB
    .prepare("SELECT key, attempts FROM media_deletions WHERE next_at <= ?1 ORDER BY next_at LIMIT 100")
    .bind(new Date(now).toISOString())
    .all();
  let deleted = 0;
  let failed = 0;
  for (const r of results || []) {
    try {
      await env.MEDIA.delete(r.key);
      await env.DB.prepare("DELETE FROM media_deletions WHERE key = ?1").bind(r.key).run();
      deleted += 1;
    } catch (err) {
      failed += 1;
      const attempts = r.attempts + 1;
      const wait = Math.min(60_000 * 2 ** attempts, 86_400_000);
      await env.DB
        .prepare("UPDATE media_deletions SET attempts = ?2, last_error = ?3, next_at = ?4 WHERE key = ?1")
        .bind(r.key, attempts, String(err?.message || err).slice(0, 200), new Date(now + wait).toISOString())
        .run();
      if (attempts >= DELETE_RETRY_MAX) console.error(JSON.stringify({ event: "media.delete_stuck", key: r.key, attempts }));
    }
  }
  return { deleted, failed };
}

/// A message unsent: its files go with it, bytes and all.
export async function dropFiles(env, orgId, messageId) {
  const { results } = await env.DB.prepare("SELECT id FROM message_files WHERE org_id = ?1 AND message_id = ?2").bind(orgId, messageId).all();
  for (const r of results || []) await deleteFileObject(env, orgId, r.id);
  await env.DB.prepare("DELETE FROM message_files WHERE org_id = ?1 AND message_id = ?2").bind(orgId, messageId).run();
}

/// Uploads nobody sent within a day, swept by the cron.
export async function sweepUnsent(env, now = Date.now()) {
  const cutoff = new Date(now - 86400000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, org_id FROM message_files WHERE message_id IS NULL AND created_at < ?1 LIMIT 200").bind(cutoff).all();
  for (const r of results || []) {
    await deleteFileObject(env, r.org_id, r.id);
    await env.DB.prepare("DELETE FROM message_files WHERE id = ?1").bind(r.id).run();
  }
  return (results || []).length;
}

// ---- Upload and fetch ----

export const UNSATISFIABLE = "unsatisfiable";

/// The one span of a file `size` bytes long that a Range header asks for:
/// `{ offset, length }` to answer in part, UNSATISFIABLE when it starts past
/// the end, or null to send the whole file — no header, several ranges, or
/// one that does not read as bytes, which RFC 9110 lets a server ignore.
/// Safari will not play a video from a server that never answers in part.
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header || "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    // bytes=-n: the last n bytes, or all of them when n is more.
    const suffix = Number(m[2]);
    if (!suffix || !size) return UNSATISFIABLE;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const first = Number(m[1]);
  const last = m[2] ? Number(m[2]) : size - 1;
  if (m[2] && last < first) return null;
  if (first >= size) return UNSATISFIABLE;
  return { offset: first, length: Math.min(last, size - 1) - first + 1 };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
});

/// POST /channels/files — the bytes, into a conversation the caller has
/// already been let into (`resolved` is from resolveChannel).
export async function uploadFile(request, env, url, { orgId, resolved, login }) {
  if (!env.MEDIA) return json({ message: "File storage is not set up here." }, 503);
  const declared = bareType(request.headers.get("content-type"));
  const promised = promisedLength(request, MAX_FILE_BYTES);
  if (promised.status === 413) return json({ message: "That file is larger than 25 MB." }, 413);
  if (promised.status) return json({ message: promised.message }, promised.status);
  if (!request.body) return json({ message: "No file in the request." }, 400);
  // What it says it is, believed only when its first bytes agree: a page
  // calling itself a picture is kept, but as bytes to download, never shown.
  const { head, stream } = await peek(request.body, HEAD_BYTES);
  const type = sniffing(env) && SHOWN.has(declared) && !looksLike(declared, head) ? "application/octet-stream" : declared;
  const id = `f_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const name = cleanName(url.searchParams.get("name"));
  const dim = (k) => { const n = Number(url.searchParams.get(k)); return Number.isInteger(n) && n > 0 && n < 100000 ? n : null; };
  // A picture's or a video's shape, as the uploader measured it, so the
  // message is drawn at that shape before the bytes arrive.
  const shaped = isPicture(type) || isVideo(type);
  try {
    // Streamed, held to the length it promised: nothing is kept of a body
    // that ends early or runs on.
    await putExactly(env, fileKey(orgId, id), stream, promised.length, { contentType: type });
  } catch {
    return json({ message: "The file did not arrive whole. Try again." }, 400);
  }
  await env.DB
    .prepare(`INSERT INTO message_files (id, org_id, channel, message_id, uploader, name, type, size, width, height, created_at)
              VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(id, orgId, resolved.key, login, name, type, promised.length, shaped ? dim("width") : null, shaped ? dim("height") : null, new Date().toISOString())
    .run();
  const row = await env.DB.prepare("SELECT * FROM message_files WHERE id = ?1").bind(id).first();
  return json({ file: await toFile(env.DB, row) }, 201);
}

/// GET /files/:id?e=…&s=… — the bytes, for a signed address still good:
/// all of them, or the one span a Range asks for, which is how a video or
/// a song is played and a long download picks up where it stopped.
export async function serveFile(request, env, url) {
  const m = url.pathname.match(/^\/files\/(f_[0-9a-f]{24})$/);
  if (!m) return null;
  const id = m[1];
  const until = Number(url.searchParams.get("e"));
  const sig = String(url.searchParams.get("s") || "");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(until) || until < now || until > now + 3 * 86400 || !sameText(sig, await mac(env.DB, id, until))) {
    return new Response("Not found", { status: 404 });
  }
  const row = await env.DB.prepare("SELECT * FROM message_files WHERE id = ?1").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  const guard = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
    "accept-ranges": "bytes",
  };
  // No validator is ever sent, so an If-Range cannot match one: the whole
  // file, as RFC 9110 asks.
  const range = request.headers.has("if-range") ? null : byteRange(request.headers.get("range"), row.size);
  if (range === UNSATISFIABLE) {
    return new Response(null, { status: 416, headers: { ...guard, "content-range": `bytes */${row.size}` } });
  }
  const obj = await getFileObject(env, row.org_id, id, range ? { range } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });
  const shown = SHOWN.has(row.type);
  // &download=1: saved, not shown, whatever it is — a link across origins
  // cannot ask for that itself, since the download attribute is ignored.
  const saving = url.searchParams.get("download") === "1";
  const encoded = encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(obj.body, {
    status: range ? 206 : 200,
    headers: {
      "content-type": shown ? (row.type === "text/plain" ? "text/plain; charset=utf-8" : row.type) : "application/octet-stream",
      "content-disposition": `${shown && !saving ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      "content-length": String(range ? range.length : row.size),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}` } : {}),
      ...guard,
      "cache-control": `private, max-age=${Math.max(0, until - now)}`,
    },
  });
}
