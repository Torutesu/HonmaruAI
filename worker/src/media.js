// Video attached to a decision card, stored in R2.
//
// Deliberately dumb: bytes land under a random id and are served back by that
// id. There is no database row — a card already carries the only reference that
// matters, and losing the object should degrade to a card without video rather
// than a card that cannot load.

import { promisedLength, peek, putExactly, looksLike, sniffing, HEAD_BYTES } from "./upload.js";
import { byteRange, UNSATISFIABLE } from "./files.js";

// The cap exists to stop one client filling the bucket: R2 bills for what it
// stores and for every operation on it (not for egress). A 60s clip exported
// at 960x540 is ~1-2 MB, far under this. The length is required up front and
// the bytes are held to it as they stream into R2 — see upload.js.
const MAX_BYTES = 12 * 1024 * 1024;

/// What this bucket is for.
///
/// The served object comes back from the Worker's own origin, and until this
/// existed it came back as whatever the upload's Content-Type header claimed —
/// so a valid session could store HTML and have this origin serve it as HTML,
/// which is script running on the API's origin from a URL that looks like
/// ours, cached `public, immutable` by everything in between. The `<video>`
/// element that makes GET /media unauthenticated needs a video and nothing
/// else; there is no reason for this to be a general-purpose file host.
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

/// The type on the wire, without its parameters and without its case.
/// `video/mp4; charset=binary` is still a video.
function bareType(header) {
  return String(header || "").split(";")[0].trim().toLowerCase();
}

function notAVideo() {
  return new Response(
    JSON.stringify({ message: `Only ${[...VIDEO_TYPES].join(", ")} can be uploaded.` }),
    { status: 415, headers: { "content-type": "application/json" } }
  );
}

// Built per call, not once at module scope: a Response carries a body stream,
// and a shared one cannot be handed out twice.
function tooLarge() {
  return new Response(
    JSON.stringify({ message: `Video is larger than ${MAX_BYTES} bytes.` }),
    { status: 413, headers: { "content-type": "application/json" } }
  );
}

/// Read the body, refusing to hold more than the cap. Kept for the small
/// uploads (avatars, emoji, icons) that still buffer; /media and
/// /channels/files stream (upload.js).
///
/// `content-length` is a claim, not a measurement: a client that omits the
/// header sends `Number(null)` — zero — straight past a check written against
/// it. Memory is bounded by the cap plus one chunk.
export async function readCapped(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let seen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(seen);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/// Where a card's video lives. New ones under their workspace
/// (docs/architecture/discord-model-platform-plan.md §4.6), so a workspace's
/// media can be exported or removed by prefix; ones stored before that, or by
/// an app that does not say which workspace, at the bare id.
export const mediaKey = (orgId, id) => (orgId ? `org/${encodeURIComponent(orgId)}/media/${id}` : id);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// POST /media[?orgId=…] — a card's video. `orgId` is the workspace the
/// caller was found to be a member of (index.js), or null for an app that
/// does not say.
export async function uploadMedia(request, env, url, { orgId = null } = {}) {
  // A missing header still means mp4, which is what the iOS client has always
  // sent and what an older build with no header meant.
  const header = request.headers.get("content-type");
  const contentType = header ? bareType(header) : "video/mp4";
  if (!VIDEO_TYPES.has(contentType)) return notAVideo();
  const promised = promisedLength(request, MAX_BYTES);
  if (promised.status === 413) return tooLarge();
  if (promised.status) {
    return new Response(JSON.stringify({ message: promised.message }), {
      status: promised.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (!request.body) {
    return new Response(JSON.stringify({ message: "No video in the request." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  // Its first bytes must be a video's, whatever the header says.
  const { head, stream } = await peek(request.body, HEAD_BYTES);
  if (sniffing(env) && !looksLike(contentType, head)) {
    await stream.cancel().catch(() => {});
    return notAVideo();
  }

  const id = crypto.randomUUID();
  try {
    await putExactly(env, mediaKey(orgId, id), stream, promised.length, { contentType });
  } catch {
    return new Response(JSON.stringify({ message: "The video did not arrive whole. Try again." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const where = new URL(`/media/${id}`, url.origin);
  if (orgId) where.searchParams.set("o", orgId);
  return new Response(JSON.stringify({ id, url: where.toString() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/// GET /media/:id[?o=…] — a card's video, whole or the one span a Range asks
/// for (Safari plays nothing from a server that never answers in part).
///
/// Still reachable by its unguessable address alone: signed, expiring
/// addresses need the card's readers to be given one when the card is read,
/// which is phase 1 of docs/architecture/media-delivery.md. Until then it is
/// at least never cached by anything shared, and only for an hour.
export async function serveMedia(id, env, request = null, url = null) {
  // Thirty days after card videos moved to signed addresses on the media
  // origin (POST /media/video), the bare address is retired: set
  // MEDIA_LEGACY_VIDEO = "off" (docs/architecture/media-delivery.md §9).
  if (String(env.MEDIA_LEGACY_VIDEO || "").toLowerCase() === "off") {
    return new Response("This address has been retired. Open the card again to play its video.", { status: 410, headers: { "cache-control": "no-store" } });
  }
  // Only what this route stored: a video's bare UUID. The same bucket holds
  // message files, compliance exports, avatars and Jam recordings, each
  // served by its own route with its own checks — never by guessing a key
  // here.
  if (!UUID.test(String(id || ""))) return new Response("not found", { status: 404 });
  const org = url?.searchParams.get("o") || null;
  const key = org ? mediaKey(org, id) : id;
  const head = await env.MEDIA.head(key);
  if (!head) return new Response("not found", { status: 404 });
  const size = head.size;
  // Checked again on the way out, not only on the way in: objects stored
  // before the upload was fussy are still in the bucket, and this is the side
  // that decides what a browser does with them.
  const stored = bareType(head.httpMetadata?.contentType);
  const contentType = VIDEO_TYPES.has(stored) ? stored : "application/octet-stream";
  const etag = head.httpEtag;
  const headers = {
    "content-type": contentType,
    // Belt and braces: a browser that would otherwise sniff its way to a
    // document type is told not to, and nothing here runs as a page.
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; media-src 'self'; sandbox",
    "referrer-policy": "no-referrer",
    "accept-ranges": "bytes",
    etag,
    // Private and short: it used to be `public, immutable` for a year, so
    // every cache on the way kept a copy nothing could take back.
    "cache-control": "private, max-age=3600",
  };
  const rangeHeader = request?.headers.get("range");
  const ifRange = request?.headers.get("if-range");
  const range = rangeHeader && (!ifRange || ifRange === etag) ? byteRange(rangeHeader, size) : null;
  if (range === UNSATISFIABLE) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  if (request?.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...headers, "content-length": String(size) } });
  }
  const object = await env.MEDIA.get(key, range ? { range } : undefined);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "content-length": String(range ? range.length : size),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` } : {}),
    },
  });
}
