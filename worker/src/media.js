// Video attached to a decision card, stored in R2.
//
// Deliberately dumb: bytes land under a random id and are served back by that
// id. There is no database row — a card already carries the only reference that
// matters, and losing the object should degrade to a card without video rather
// than a card that cannot load.

// Storage is the only thing R2 bills for (egress is free), so the cap exists to
// stop one bad client filling the bucket. A 60s clip exported at 960x540 is
// ~1-2 MB, far under this.
const MAX_BYTES = 12 * 1024 * 1024;

export async function uploadMedia(request, env, url) {
  const contentType = request.headers.get("content-type") || "video/mp4";
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) {
    return new Response(JSON.stringify({ message: `Video is larger than ${MAX_BYTES} bytes.` }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  const id = crypto.randomUUID();
  await env.MEDIA.put(id, request.body, { httpMetadata: { contentType } });
  return new Response(JSON.stringify({ id, url: `${url.origin}/media/${id}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function serveMedia(id, env) {
  const object = await env.MEDIA.get(id);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.httpMetadata?.contentType || "video/mp4",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
