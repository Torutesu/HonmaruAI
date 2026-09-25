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

import { readCapped } from "./media.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
const ID = /^f_[0-9a-f]{24}$/;

const SHOWN = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm",
  "text/plain",
]);
export const isPicture = (type) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);

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

/// A file as a browser sees it.
export async function toFile(db, row, now = Date.now()) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: row.size,
    width: row.width || null,
    height: row.height || null,
    url: await signedPath(db, row.id, now),
  };
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

/// A message unsent: its files go with it, bytes and all.
export async function dropFiles(env, orgId, messageId) {
  const { results } = await env.DB.prepare("SELECT id FROM message_files WHERE org_id = ?1 AND message_id = ?2").bind(orgId, messageId).all();
  for (const r of results || []) await env.MEDIA?.delete(`file-${r.id}`).catch(() => {});
  await env.DB.prepare("DELETE FROM message_files WHERE org_id = ?1 AND message_id = ?2").bind(orgId, messageId).run();
}

/// Uploads nobody sent within a day, swept by the cron.
export async function sweepUnsent(env, now = Date.now()) {
  const cutoff = new Date(now - 86400000).toISOString();
  const { results } = await env.DB.prepare("SELECT id FROM message_files WHERE message_id IS NULL AND created_at < ?1 LIMIT 200").bind(cutoff).all();
  for (const r of results || []) {
    await env.MEDIA?.delete(`file-${r.id}`).catch(() => {});
    await env.DB.prepare("DELETE FROM message_files WHERE id = ?1").bind(r.id).run();
  }
  return (results || []).length;
}

// ---- Upload and fetch ----

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
});

/// POST /channels/files — the bytes, into a conversation the caller has
/// already been let into (`resolved` is from resolveChannel).
export async function uploadFile(request, env, url, { orgId, resolved, login }) {
  if (!env.MEDIA) return json({ message: "File storage is not set up here." }, 503);
  const type = bareType(request.headers.get("content-type"));
  const claimed = Number(request.headers.get("content-length") || 0);
  if (claimed > MAX_FILE_BYTES) return json({ message: "That file is larger than 25 MB." }, 413);
  if (!request.body) return json({ message: "No file in the request." }, 400);
  const bytes = await readCapped(request.body, MAX_FILE_BYTES);
  if (!bytes) return json({ message: "That file is larger than 25 MB." }, 413);
  if (!bytes.byteLength) return json({ message: "That file is empty." }, 400);
  const id = `f_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const name = cleanName(url.searchParams.get("name"));
  const dim = (k) => { const n = Number(url.searchParams.get(k)); return Number.isInteger(n) && n > 0 && n < 100000 ? n : null; };
  const picture = isPicture(type);
  await env.MEDIA.put(`file-${id}`, bytes, { httpMetadata: { contentType: type } });
  await env.DB
    .prepare(`INSERT INTO message_files (id, org_id, channel, message_id, uploader, name, type, size, width, height, created_at)
              VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(id, orgId, resolved.key, login, name, type, bytes.byteLength, picture ? dim("width") : null, picture ? dim("height") : null, new Date().toISOString())
    .run();
  const row = await env.DB.prepare("SELECT * FROM message_files WHERE id = ?1").bind(id).first();
  return json({ file: await toFile(env.DB, row) }, 201);
}

/// GET /files/:id?e=…&s=… — the bytes, for a signed address still good.
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
  const obj = row && env.MEDIA ? await env.MEDIA.get(`file-${id}`) : null;
  if (!obj) return new Response("Not found", { status: 404 });
  const shown = SHOWN.has(row.type);
  const encoded = encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(obj.body, {
    headers: {
      "content-type": shown ? (row.type === "text/plain" ? "text/plain; charset=utf-8" : row.type) : "application/octet-stream",
      "content-disposition": `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      "content-length": String(row.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
      "cache-control": `private, max-age=${Math.max(0, until - now)}`,
    },
  });
}
