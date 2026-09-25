import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { sweepUnsent, cleanName, validUntil } from "../src/files.js";
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
const upload = (token, channel, { name = "photo.png", type = "image/png", bytes = PNG, width = 640, height = 480 } = {}) =>
  call(`/channels/files?${q({ orgId: ORG, channel, name, width, height })}`, { method: "POST", headers: auth(token, { "content-type": type }), body: bytes });
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
  expect(await env.MEDIA.get(`file-${file.id}`)).toBeNull();

  const { file: orphan } = await (await upload(mika, "b:cafe")).json();
  expect(await sweepUnsent(env)).toBe(0);
  expect(await sweepUnsent(env, Date.now() + 2 * 86400000)).toBe(1);
  expect(await env.MEDIA.get(`file-${orphan.id}`)).toBeNull();
});

test("too big is refused before it is stored", async () => {
  const res = await call(`/channels/files?${q({ orgId: ORG, channel: "b:cafe", name: "big.bin" })}`, {
    method: "POST", headers: auth(mika, { "content-type": "application/octet-stream", "content-length": String(30 * 1024 * 1024) }), body: new Uint8Array(4),
  });
  expect(res.status).toBe(413);
});
