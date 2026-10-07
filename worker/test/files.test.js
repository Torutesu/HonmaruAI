import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { sweepUnsent, cleanName, validUntil, byteRange, UNSATISFIABLE } from "../src/files.js";
import { transcriptUpTo, channelActivity } from "../src/channels.js";

// Files and pictures in a conversation: uploaded into a place you can read,
// sent with a message, fetched only by a signed address, gone when the
// message is.

const ORG = "personal:files";
let toru; let mika; let kenji; let outsider; let refs;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), env, ctx);
  await settle();
  return res;
};
const q = (o) => new URLSearchParams(o).toString();
const auth = (token, extra = {}) => ({ "x-session-token": token, ...extra });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
// The first bytes of each kind, as a real file of it starts: an upload is
// only shown as what it says it is when its first bytes agree.
const enc = (text) => new TextEncoder().encode(text);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...enc("ftypisom"), 0, 0, 2, 0, ...enc("isomiso2")]);
const SAMPLE = {
  "video/mp4": MP4, "video/quicktime": new Uint8Array([0, 0, 0, 0x14, ...enc("ftypqt  "), 0, 0, 0, 0, ...enc("qt  ")]),
  "video/webm": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
  "audio/mpeg": new Uint8Array([...enc("ID3"), 4, 0, 0, 0, 0, 0, 0]),
  "audio/x-m4a": new Uint8Array([0, 0, 0, 0x1c, ...enc("ftypM4A "), 0, 0, 0, 0]),
  "audio/aac": new Uint8Array([0xff, 0xf1, 0x50, 0x80, 1, 2]),
  "audio/flac": new Uint8Array([...enc("fLaC"), 0, 0, 0, 0x22]),
  "audio/x-wav": new Uint8Array([...enc("RIFF"), 36, 0, 0, 0, ...enc("WAVEfmt ")]),
  "text/plain": enc("notes for the week"),
};
const upload = (token, channel, { name = "photo.png", type = "image/png", bytes = SAMPLE[type] || PNG, width = 640, height = 480 } = {}) =>
  call(`/channels/files?${q({ orgId: ORG, channel, name, width, height })}`, {
    method: "POST", headers: auth(token, { "content-type": type, "content-length": String(bytes.byteLength ?? enc(bytes).byteLength) }), body: bytes,
  });
const say = async (token, channel, body, files) => call("/channels/messages", {
  method: "POST", headers: auth(token, { "content-type": "application/json" }), body: JSON.stringify({ orgId: ORG, channel, body, files }),
});
const list = async (token, channel) => (await (await call(`/channels/messages?${q({ orgId: ORG, channel })}`, { headers: auth(token) })).json()).messages;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9801", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9802", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9803", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9804", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9801", "admin");
  await upsertMembership(env.DB, ORG, "9802", "member");
  await upsertMembership(env.DB, ORG, "9803", "member");
  await upsertMembership(env.DB, "personal:elsewhere", "9804", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  toru = await createSession(env.DB, "9801", "gho_t");
  mika = await createSession(env.DB, "9802", "gho_m");
  kenji = await createSession(env.DB, "9803", "gho_k");
  outsider = await createSession(env.DB, "9804", "gho_n");
  const people = await (await call(`/channels?${q({ orgId: ORG })}`, { headers: auth(toru) })).json();
  refs = Object.fromEntries(people.members.map((m) => [m.name, m.ref]));
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a picture goes up, rides a message, and everyone in the channel can see it", async () => {
  const up = await upload(mika, "b:cafe");
  expect(up.status).toBe(201);
  const { file } = await up.json();
  expect(file).toMatchObject({ name: "photo.png", type: "image/png", size: PNG.length, width: 640, height: 480 });
  expect(file.url).toMatch(/^\/files\/f_[0-9a-f]{24}\?e=\d+&s=[0-9a-f]{32}$/);

  // A picture on its own is a message.
  const sent = await say(mika, "b:cafe", "", [file.id]);
  expect(sent.status).toBe(201);
  const [seen] = await list(kenji, "b:cafe");
  expect(seen.files).toHaveLength(1);
  expect(seen.files[0]).toMatchObject({ id: file.id, name: "photo.png" });

  const got = await call(seen.files[0].url, {});
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(got.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(got.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);

  // What the AI reads, and the sidebar's line, say what was sent.
  const lines = await transcriptUpTo(env.DB, ORG, "b:cafe", new Date().toISOString());
  expect(lines.join("\n")).toContain("[attached: photo.png]");
  const [act] = await channelActivity(env.DB, ORG, "kenji", [{ login: "mika", ref: refs.Mika }]);
  expect(act.preview).toBe("📎 photo.png");
});

test("an address that is unsigned, tampered with or stale fetches nothing", async () => {
  const { file } = await (await upload(mika, "b:cafe")).json();
  const [path, query] = file.url.split("?");
  const p = new URLSearchParams(query);
  expect((await call(path, {})).status).toBe(404);
  expect((await call(`${path}?e=${p.get("e")}&s=${"0".repeat(32)}`, {})).status).toBe(404);
  expect((await call(`${path}?e=${Number(p.get("e")) + 86400}&s=${p.get("s")}`, {})).status).toBe(404);
  const stale = Math.floor(Date.now() / 1000) - 10;
  expect((await call(`${path}?e=${stale}&s=${p.get("s")}`, {})).status).toBe(404);
  expect(validUntil(Date.UTC(2026, 0, 1, 23, 0)) - Date.UTC(2026, 0, 1) / 1000).toBe(2 * 86400);
});

test("a file in a DM is for the two people in it, and only its uploader can send it", async () => {
  const outside = await upload(kenji, `dm:${refs.Mika}`);
  expect(outside.status).toBe(201);
  // Uploaded into Kenji's DM with Mika; Toru cannot attach it anywhere.
  const { file } = await outside.json();
  const stolen = await say(toru, "b:cafe", "look", [file.id]);
  expect(stolen.status).toBe(201);
  const [msg] = await list(toru, "b:cafe");
  expect(msg.files).toEqual([]);
  // Nor post it bare: nothing claimable means nothing said.
  expect((await say(toru, "b:cafe", "", [file.id])).status).toBe(400);
  // Mika sees it in her DM with Kenji; nobody outside the workspace uploads.
  await say(kenji, `dm:${refs.Mika}`, "the invoice", [file.id]);
  const [dm] = await list(mika, `dm:${refs.Kenji}`);
  expect(dm.files.map((f) => f.id)).toEqual([file.id]);
  expect((await upload(outsider, "b:cafe")).status).toBe(403);
});

test("anything but a picture, video, audio or text is a download, sandboxed", async () => {
  const html = new TextEncoder().encode("<script>alert(1)</script>");
  const { file } = await (await upload(mika, "b:cafe", { name: "../../evil.html", type: "text/html", bytes: html })).json();
  expect(file.name).toBe("evil.html");
  expect(file.width).toBeNull();
  const got = await call(file.url, {});
  expect(got.headers.get("content-type")).toBe("application/octet-stream");
  expect(got.headers.get("content-disposition")).toMatch(/^attachment; filename\*=UTF-8''evil\.html$/);
  expect(got.headers.get("content-security-policy")).toContain("sandbox");
  expect(cleanName("a\u0000b\nc.txt")).toBe("abc.txt");
});

test("unsending a message takes its files; an upload never sent is swept after a day", async () => {
  const { file } = await (await upload(mika, "b:cafe")).json();
  const { message } = await (await say(mika, "b:cafe", "here", [file.id])).json();
  await call("/channels/messages", { method: "DELETE", headers: auth(mika, { "content-type": "application/json" }), body: JSON.stringify({ orgId: ORG, channel: "b:cafe", messageId: message.id }) });
  expect((await call(file.url, {})).status).toBe(404);
  expect(await env.MEDIA.get(`org/${encodeURIComponent(ORG)}/files/${file.id}`)).toBeNull();

  const { file: orphan } = await (await upload(mika, "b:cafe")).json();
  expect(await sweepUnsent(env)).toBe(0);
  expect(await sweepUnsent(env, Date.now() + 2 * 86400000)).toBe(1);
  expect(await env.MEDIA.get(`org/${encodeURIComponent(ORG)}/files/${orphan.id}`)).toBeNull();
});

test("too big is refused before it is stored", async () => {
  const res = await call(`/channels/files?${q({ orgId: ORG, channel: "b:cafe", name: "big.bin" })}`, {
    method: "POST", headers: auth(mika, { "content-type": "application/octet-stream", "content-length": String(30 * 1024 * 1024) }), body: new Uint8Array(4),
  });
  expect(res.status).toBe(413);
});

test("bytes are kept under the workspace, and files stored before that still open", async () => {
  const { file } = await (await upload(mika, "b:cafe")).json();
  const key = `org/${encodeURIComponent(ORG)}/files/${file.id}`;
  const obj = await env.MEDIA.get(key);
  expect(obj).not.toBeNull();
  expect(await env.MEDIA.get(`file-${file.id}`)).toBeNull();

  // As a file uploaded before the prefix: only the old key has the bytes.
  await env.MEDIA.put(`file-${file.id}`, await obj.arrayBuffer());
  await env.MEDIA.delete(key);
  expect((await call(file.url, {})).status).toBe(200);
  const part = await call(file.url, { headers: { range: "bytes=1-3" } });
  expect(part.status).toBe(206);
  expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...PNG.slice(1, 4)]);
  await say(mika, "b:cafe", "old one", [file.id]);
});

test("a video is answered in parts, the way a player asks for it", async () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  bytes.set(enc("ftypisom"), 4);
  const { file } = await (await upload(mika, "b:cafe", { name: "clip.mp4", type: "video/mp4", bytes })).json();
  const get = (range, extra = {}) => call(file.url, { headers: { range, ...extra } });
  const body = async (res) => [...new Uint8Array(await res.arrayBuffer())];

  const whole = await call(file.url, {});
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("content-length")).toBe("100");
  expect(whole.headers.get("content-range")).toBeNull();
  expect(await body(whole)).toEqual([...bytes]);

  // Safari's first question, then the rest of the file.
  const probe = await get("bytes=0-1");
  expect(probe.status).toBe(206);
  expect(probe.headers.get("content-range")).toBe("bytes 0-1/100");
  expect(probe.headers.get("content-length")).toBe("2");
  expect(probe.headers.get("accept-ranges")).toBe("bytes");
  expect(probe.headers.get("content-type")).toBe("video/mp4");
  expect(probe.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(probe.headers.get("content-security-policy")).toContain("sandbox");
  expect(probe.headers.get("x-content-type-options")).toBe("nosniff");
  expect(probe.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
  expect(await body(probe)).toEqual([0, 1]);

  const middle = await get("bytes=10-19");
  expect(middle.headers.get("content-range")).toBe("bytes 10-19/100");
  expect(await body(middle)).toEqual([...bytes.slice(10, 20)]);
  const rest = await get("bytes=90-");
  expect(rest.headers.get("content-range")).toBe("bytes 90-99/100");
  expect(await body(rest)).toEqual([...bytes.slice(90)]);
  const tail = await get("bytes=-5");
  expect(tail.headers.get("content-range")).toBe("bytes 95-99/100");
  expect(tail.headers.get("content-length")).toBe("5");
  expect(await body(tail)).toEqual([95, 96, 97, 98, 99]);
  const over = await get("bytes=98-500");
  expect(over.headers.get("content-range")).toBe("bytes 98-99/100");
  expect(await body(over)).toEqual([98, 99]);

  // Past the end: nothing, and how long the file is.
  const past = await get("bytes=100-");
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe("bytes */100");
  expect(past.headers.get("accept-ranges")).toBe("bytes");

  // Several ranges, another unit, or an If-Range with nothing to match: all of it.
  for (const res of [await get("bytes=0-1,5-6"), await get("items=0-1"), await get("bytes=0-1", { "if-range": '"x"' })]) {
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual([...bytes]);
  }
});

test("a video keeps the shape it was measured at; a song and a document have none", async () => {
  const { file: clip } = await (await upload(mika, "b:cafe", { name: "clip.mov", type: "video/quicktime", width: 1080, height: 1920 })).json();
  expect(clip).toMatchObject({ type: "video/quicktime", width: 1080, height: 1920 });
  const { file: song } = await (await upload(mika, "b:cafe", { name: "song.mp3", type: "audio/mpeg" })).json();
  expect(song).toMatchObject({ type: "audio/mpeg", width: null, height: null });
  const { file: doc } = await (await upload(mika, "b:cafe", { name: "notes.txt", type: "text/plain" })).json();
  expect(doc).toMatchObject({ width: null, height: null });
  const { file: odd } = await (await upload(mika, "b:cafe", { name: "clip.webm", type: "video/webm", width: -4, height: 1e6 })).json();
  expect(odd).toMatchObject({ width: null, height: null });
});

test("a voice memo is played where it is, under the type the browser gave it", async () => {
  for (const type of ["audio/x-m4a", "audio/aac", "audio/flac", "audio/x-wav"]) {
    const { file } = await (await upload(mika, "b:cafe", { name: "memo", type })).json();
    const got = await call(file.url, {});
    expect(got.headers.get("content-type")).toBe(type);
    expect(got.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
  }
});

test("a signed address asked to download saves the file instead of showing it", async () => {
  const { file } = await (await upload(mika, "b:cafe", { name: "clip.mp4", type: "video/mp4" })).json();
  const saved = await call(`${file.url}&download=1`, {});
  expect(saved.status).toBe(200);
  expect(saved.headers.get("content-type")).toBe("video/mp4");
  expect(saved.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''clip.mp4");
  expect((await call(`${file.url}&download=0`, {})).headers.get("content-disposition")).toMatch(/^inline;/);
  // The signature is still the whole of who may fetch it.
  const [path, query] = file.url.split("?");
  const p = new URLSearchParams(query);
  expect((await call(`${path}?e=${p.get("e")}&s=${"0".repeat(32)}&download=1`, {})).status).toBe(404);
});

test("a Range opens nothing a plain request does not, and a download stays one", async () => {
  const html = new TextEncoder().encode("<script>alert(1)</script>");
  const { file } = await (await upload(mika, "b:cafe", { name: "page.html", type: "text/html", bytes: html })).json();
  const [path, query] = file.url.split("?");
  const p = new URLSearchParams(query);
  expect((await call(path, { headers: { range: "bytes=0-1" } })).status).toBe(404);
  expect((await call(`${path}?e=${p.get("e")}&s=${"0".repeat(32)}`, { headers: { range: "bytes=999-" } })).status).toBe(404);

  const part = await call(file.url, { headers: { range: "bytes=0-7" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-type")).toBe("application/octet-stream");
  expect(part.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(part.headers.get("content-security-policy")).toContain("sandbox");
  expect(await part.text()).toBe("<script>");

  // Unsent with its message, the bytes are gone, however they are asked for.
  const { message } = await (await say(mika, "b:cafe", "here", [file.id])).json();
  await call("/channels/messages", { method: "DELETE", headers: auth(mika, { "content-type": "application/json" }), body: JSON.stringify({ orgId: ORG, channel: "b:cafe", messageId: message.id }) });
  expect((await call(file.url, { headers: { range: "bytes=0-1" } })).status).toBe(404);
  expect((await call(file.url, { headers: { range: "bytes=999-" } })).status).toBe(404);
});

test("a Range header reads as one span of the file, or is ignored", () => {
  expect(byteRange("bytes=0-1", 100)).toEqual({ offset: 0, length: 2 });
  expect(byteRange("bytes=10-19", 100)).toEqual({ offset: 10, length: 10 });
  expect(byteRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
  expect(byteRange("bytes=0-", 100)).toEqual({ offset: 0, length: 100 });
  expect(byteRange("bytes=-5", 100)).toEqual({ offset: 95, length: 5 });
  // Past the end is the rest of the file; a suffix longer than it, all of it.
  expect(byteRange("bytes=95-1000", 100)).toEqual({ offset: 95, length: 5 });
  expect(byteRange("bytes=-500", 100)).toEqual({ offset: 0, length: 100 });
  expect(byteRange("Bytes=99-99", 100)).toEqual({ offset: 99, length: 1 });
  // Nothing the file has.
  expect(byteRange("bytes=100-", 100)).toBe(UNSATISFIABLE);
  expect(byteRange("bytes=100-200", 100)).toBe(UNSATISFIABLE);
  expect(byteRange("bytes=-0", 100)).toBe(UNSATISFIABLE);
  // Not asked, several ranges, another unit, or backwards: the whole file.
  for (const h of [null, "", "bytes=", "bytes=-", "bytes=0-1,5-6", "items=0-1", "bytes=5-2", "bytes=a-b", "bytes=1.5-2"]) {
    expect(byteRange(h, 100)).toBeNull();
  }
});

test("a page calling itself a picture is kept, but as bytes to download, never shown", async () => {
  const page = enc("<html><script>alert(document.domain)</script></html>");
  const { file } = await (await upload(mika, "b:cafe", { name: "cat.png", type: "image/png", bytes: page })).json();
  expect(file.type).toBe("application/octet-stream");
  const got = await call(file.url, {});
  expect(got.headers.get("content-type")).toBe("application/octet-stream");
  expect(got.headers.get("content-disposition")).toMatch(/^attachment;/);
});

test("an upload that will not say how long it is is refused before it is stored", async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(PNG); c.close(); } });
  const res = await call(`/channels/files?${q({ orgId: ORG, channel: "b:cafe", name: "p.png" })}`, {
    method: "POST", headers: auth(mika, { "content-type": "image/png" }), body, duplex: "half",
  });
  expect(res.status).toBe(411);
  const { results } = await env.DB.prepare("SELECT id FROM message_files").all();
  expect(results).toHaveLength(0);
});

test("a delete R2 refuses is written down and tried again until it goes", async () => {
  const { deleteMediaKeys, retryMediaDeletions } = await import("../src/files.js");
  let refusing = true;
  const deleted = [];
  const flaky = { DB: env.DB, MEDIA: { delete: async (key) => { if (refusing) throw new Error("R2 is down"); deleted.push(key); } } };
  expect(await deleteMediaKeys(flaky, ORG, ["org/x/files/f_1", "file-f_1"])).toBe(2);
  const kept = await env.DB.prepare("SELECT key, attempts FROM media_deletions ORDER BY key").all();
  expect(kept.results.map((r) => r.key)).toEqual(["file-f_1", "org/x/files/f_1"]);

  // Still refused: tried, and put off for longer.
  expect(await retryMediaDeletions(flaky)).toEqual({ deleted: 0, failed: 2 });
  const later = await env.DB.prepare("SELECT attempts, next_at FROM media_deletions").all();
  expect(later.results.every((r) => r.attempts === 1 && Date.parse(r.next_at) > Date.now())).toBe(true);
  // Not due yet: left alone.
  expect(await retryMediaDeletions(flaky)).toEqual({ deleted: 0, failed: 0 });

  // R2 is back, and the time has come.
  refusing = false;
  expect(await retryMediaDeletions(flaky, Date.now() + 86_400_000)).toEqual({ deleted: 2, failed: 0 });
  expect(deleted.sort()).toEqual(["file-f_1", "org/x/files/f_1"]);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media_deletions").first()).n).toBe(0);
});
