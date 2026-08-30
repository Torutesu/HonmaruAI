import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession } from "../src/db.js";

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "77", "gho_media");
});

test("POST /media stores the body and GET /media/:id returns it", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const up = await SELF.fetch("https://example.com/media", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "video/mp4" },
    body: bytes,
  });
  expect(up.status).toBe(200);
  const { id, url } = await up.json();
  expect(typeof id).toBe("string");
  expect(url).toContain(`/media/${id}`);

  const down = await SELF.fetch(`https://example.com/media/${id}`);
  expect(down.status).toBe(200);
  expect(down.headers.get("content-type")).toBe("video/mp4");
  expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes);
});

test("POST /media requires a session", async () => {
  const res = await SELF.fetch("https://example.com/media", {
    method: "POST",
    headers: { "content-type": "video/mp4" },
    body: new Uint8Array([1]),
  });
  expect(res.status).toBe(401);
});

test("GET /media/:id is 404 for an unknown id", async () => {
  const res = await SELF.fetch("https://example.com/media/does-not-exist");
  expect(res.status).toBe(404);
});

// The cap used to be read off `content-length`, which is a claim the client
// makes about itself. Omitting the header sent `Number(null)` — zero — past
// the check, and then whatever the client felt like streaming went into the
// bucket. R2 storage is the thing we pay for.
test("an upload larger than the cap is refused even with no content-length", async () => {
  // A streamed body carries no content-length, which is the whole point: the
  // old check read that header, and `Number(null)` is zero. Nothing about the
  // request said how big it was, and 13 MB went into the bucket anyway.
  const MB = new Uint8Array(1024 * 1024);
  let left = 13;
  const body = new ReadableStream({
    pull(controller) {
      if (left-- <= 0) return controller.close();
      controller.enqueue(MB);
    },
  });

  const res = await SELF.fetch("https://example.com/media", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "video/mp4" },
    body,
    duplex: "half",
  });
  expect(res.headers.get("content-length")).toBeNull();
  expect(res.status).toBe(413);
});

test("an honest oversized content-length is refused before the body is read", async () => {
  const res = await SELF.fetch("https://example.com/media", {
    method: "POST",
    headers: {
      "x-session-token": token,
      "content-type": "video/mp4",
      "content-length": String(20 * 1024 * 1024),
    },
    body: new Uint8Array(16),
  });
  expect(res.status).toBe(413);
});
