import { expect, test } from "vitest";
import { uploadMedia, serveMedia } from "../src/media.js";

// What comes back out of /media is served from the Worker's own origin, and
// what it is served *as* came straight off the upload's Content-Type header.
//
// So a valid session could store HTML and have this origin serve it as HTML —
// script running on the API's origin, from a URL that looks like ours, cached
// `public, immutable` by everything in between. The `<video>` element that
// makes GET /media unauthenticated needs a video and nothing else; there is no
// reason for this to be a general-purpose file host.
//
// Driven against the two functions rather than through SELF, and so against no
// bucket at all: the harness cannot pop R2's isolated storage once a file has
// written to it more than once, and media.test.js already spends that one
// write on the round trip.

function bucket() {
  const put = [];
  return {
    put,
    // Drains what it is given, as R2 would.
    env: { MEDIA: { put: async (id, body, opts) => { await new Response(body).arrayBuffer(); put.push({ id, opts }); } } },
  };
}

// The first bytes of a real camera file of each kind: the route believes the
// header only when the bytes agree.
const enc = (text) => new TextEncoder().encode(text);
const HEADS = {
  "video/mp4": new Uint8Array([0, 0, 0, 0x18, ...enc("ftypisom"), 0, 0, 2, 0]),
  "video/quicktime": new Uint8Array([0, 0, 0, 0x14, ...enc("ftypqt  "), 0, 0, 0, 0]),
  "video/webm": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
};

function post(contentType, body) {
  const bare = (contentType || "video/mp4").split(";")[0];
  const payload = body === undefined ? (HEADS[bare] || HEADS["video/mp4"]) : (typeof body === "string" ? enc(body) : body);
  return new Request("https://example.com/media", {
    method: "POST",
    headers: { ...(contentType ? { "content-type": contentType } : {}), "content-length": String(payload.byteLength) },
    body: payload,
  });
}

const url = new URL("https://example.com/media");

test("the formats a camera produces are stored as themselves", async () => {
  for (const type of ["video/mp4", "video/quicktime", "video/webm"]) {
    const store = bucket();
    const res = await uploadMedia(post(type), store.env, url);
    expect(res.status).toBe(200);
    expect(store.put[0].opts.httpMetadata.contentType).toBe(type);
  }
});

test("a parameter on the header does not make it a different format", async () => {
  const store = bucket();
  const res = await uploadMedia(post("video/mp4; charset=binary"), store.env, url);
  expect(res.status).toBe(200);
  expect(store.put[0].opts.httpMetadata.contentType).toBe("video/mp4");
});

test("no header at all still means what it always meant", async () => {
  // Older builds sent none, and the route read that as mp4.
  const store = bucket();
  const res = await uploadMedia(post(null), store.env, url);
  expect(res.status).toBe(200);
  expect(store.put[0].opts.httpMetadata.contentType).toBe("video/mp4");
});

test("anything that is not a video is turned away, with the reason", async () => {
  for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/plain"]) {
    const store = bucket();
    const res = await uploadMedia(post(type, "<svg/>"), store.env, url);
    expect(res.status).toBe(415);
    // Refused before a byte reaches the bucket.
    expect(store.put).toHaveLength(0);
    expect((await res.json()).message).toContain("video/mp4");
  }
});

test("an object stored before this was fussy is not served as a document", async () => {
  // The bucket predates the check, so whatever is already in it, the side that
  // decides what a browser does with those bytes is this one.
  const stored = (contentType) => ({
    MEDIA: {
      head: async () => ({ size: 3, httpEtag: '"e"', httpMetadata: { contentType } }),
      get: async () => ({ body: new Uint8Array([1, 2, 3]), httpMetadata: { contentType } }),
    },
  });

  for (const type of ["text/html", "image/svg+xml"]) {
    const res = await serveMedia("0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b", stored(type));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  }

  const good = await serveMedia("1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", stored("video/mp4"));
  expect(good.headers.get("content-type")).toBe("video/mp4");
  // And nothing downstream may sniff its way back to a document either.
  expect(good.headers.get("x-content-type-options")).toBe("nosniff");
});

test("a missing object is still a 404", async () => {
  const res = await serveMedia("0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b", { MEDIA: { head: async () => null, get: async () => null } });
  expect(res.status).toBe(404);
});

test("only a video this route stored is served: a file, an export or an avatar in the same bucket is not", async () => {
  const every = { MEDIA: { head: async () => ({ size: 1, httpEtag: '"e"', httpMetadata: { contentType: "application/gzip" } }), get: async () => ({ body: new Uint8Array([1]), httpMetadata: { contentType: "application/gzip" } }) } };
  for (const key of ["compliance-export-0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b", "file-f_abc123", "jam/0f8e2c1a", "user-avatar-x", "../x"]) {
    expect((await serveMedia(key, every)).status).toBe(404);
  }
});

test("a file that only says it is a video is turned away", async () => {
  // The header is the uploader's word; the first bytes are what it is.
  for (const body of ["<html><script>alert(1)</script>", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]) {
    const store = bucket();
    const res = await uploadMedia(post("video/mp4", body), store.env, url);
    expect(res.status).toBe(415);
    expect(store.put).toHaveLength(0);
  }
});

test("an upload must say how long it is, and is held to it", async () => {
  const store = bucket();
  const unsaid = new Request("https://example.com/media", { method: "POST", headers: { "content-type": "video/mp4" }, body: HEADS["video/mp4"] });
  expect((await uploadMedia(unsaid, store.env, url)).status).toBe(411);
  expect(store.put).toHaveLength(0);
});

test("a video named for a workspace is kept under it, and its address says so", async () => {
  const store = bucket();
  const res = await uploadMedia(post("video/mp4"), store.env, url, { orgId: "personal:toru" });
  expect(res.status).toBe(200);
  const { id, url: where } = await res.json();
  expect(store.put[0].id).toBe(`org/${encodeURIComponent("personal:toru")}/media/${id}`);
  expect(new URL(where).searchParams.get("o")).toBe("personal:toru");
});

test("a video is served in parts, privately, never cached by anything shared", async () => {
  const bytes = Uint8Array.from({ length: 20 }, (_, i) => i);
  const env = {
    MEDIA: {
      head: async () => ({ size: 20, httpEtag: '"v1"', httpMetadata: { contentType: "video/mp4" } }),
      get: async (_key, opts) => ({ body: opts?.range ? bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : bytes }),
    },
  };
  const id = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const ask = (headers) => serveMedia(id, env, new Request(`https://example.com/media/${id}`, { headers }), new URL(`https://example.com/media/${id}`));
  const part = await ask({ range: "bytes=0-1" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 0-1/20");
  expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([0, 1]);
  expect(part.headers.get("cache-control")).toBe("private, max-age=3600");
  expect(part.headers.get("referrer-policy")).toBe("no-referrer");
  expect((await ask({ range: "bytes=40-" })).status).toBe(416);
  // An If-Range for another version gets the whole file.
  expect((await ask({ range: "bytes=0-1", "if-range": '"old"' })).status).toBe(200);
});
