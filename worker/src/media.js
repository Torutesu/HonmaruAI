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

// The bucket is served back over this origin, so what goes into it is what a
// browser will be asked to render. An upload declaring `text/html` was stored
// and served with that content type, which makes `/media/:id` a place to host a
// page on the app's own origin — the shape of every stored-XSS report there has
// ever been. Video is the only thing this endpoint is for.
const ALLOWED_PREFIX = "video/";

function unsupportedType(contentType) {
  return new Response(
    JSON.stringify({ message: `Only video uploads are accepted, not ${contentType}.` }),
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
  // Bare, without parameters: `video/mp4; codecs=avc1` is a video.
  const contentType = (request.headers.get("content-type") || "video/mp4").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith(ALLOWED_PREFIX)) return unsupportedType(contentType);
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
  const stored = object.httpMetadata?.contentType || "video/mp4";
  return new Response(object.body, {
    status: 200,
    headers: {
      // Objects written before the upload check existed can still carry
      // anything, so the served type is clamped too rather than trusted.
      "content-type": stored.startsWith(ALLOWED_PREFIX) ? stored : "application/octet-stream",
      // Belt and braces: no sniffing our way back to text/html.
      "x-content-type-options": "nosniff",
      // A person's recording is not public. Shared caches must not keep a copy
      // of one, and the response is only reachable with a session anyway.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
