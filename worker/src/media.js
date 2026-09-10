// Video attached to a decision card, stored in R2.
//
// Deliberately dumb: bytes land under a random id and are served back by that
// id. There is no database row — a card already carries the only reference that
// matters, and losing the object should degrade to a card without video rather
// than a card that cannot load.

// Storage is the only thing R2 bills for (egress is free), so the cap exists to
// stop one bad client filling the bucket. A 60s clip exported at 960x540 is
// ~1-2 MB, far under this. Enforced on the bytes received, not on the length
// the client claims — see `readCapped` below.
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

/// Read the body, refusing to hold more than the cap.
///
/// `content-length` is a claim, not a measurement: a client that omits the
/// header sends `Number(null)` — zero — straight past a check written against
/// it, and then streams whatever it likes into the bucket. The header is still
/// worth reading, because rejecting before a byte is transferred is cheaper
/// than rejecting after; it just cannot be the only thing standing between an
/// upload and R2.
///
/// Buffered rather than piped because R2 will not take a stream of unknown
/// length, and the length is exactly what is in question here. Memory is
/// bounded by the cap plus one chunk, which is the point.
async function readCapped(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let seen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      // Stop pulling. Draining the rest would mean paying to receive bytes we
      // have already decided to refuse.
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

export async function uploadMedia(request, env, url) {
  // A missing header still means mp4, which is what the iOS client has always
  // sent and what an older build with no header meant.
  const header = request.headers.get("content-type");
  const contentType = header ? bareType(header) : "video/mp4";
  if (!VIDEO_TYPES.has(contentType)) return notAVideo();
  const claimed = Number(request.headers.get("content-length") || 0);
  // Cheap rejection for an honest client that is simply too big.
  if (claimed > MAX_BYTES) return tooLarge();
  if (!request.body) {
    return new Response(JSON.stringify({ message: "No video in the request." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const bytes = await readCapped(request.body, MAX_BYTES);
  if (!bytes) return tooLarge();

  const id = crypto.randomUUID();
  await env.MEDIA.put(id, bytes, { httpMetadata: { contentType } });
  return new Response(JSON.stringify({ id, url: `${url.origin}/media/${id}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function serveMedia(id, env) {
  const object = await env.MEDIA.get(id);
  if (!object) return new Response("not found", { status: 404 });
  // Checked again on the way out, not only on the way in: objects stored
  // before the upload was fussy are still in the bucket, and this is the side
  // that decides what a browser does with them.
  const stored = bareType(object.httpMetadata?.contentType);
  const contentType = VIDEO_TYPES.has(stored) ? stored : "application/octet-stream";
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      // Belt and braces: a browser that would otherwise sniff its way to a
      // document type is told not to.
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
