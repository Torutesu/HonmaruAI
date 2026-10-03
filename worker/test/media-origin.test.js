import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { signFileUrl, verifyFileUrl, WINDOW_SECONDS, mediaOriginOn } from "../src/mediaToken.js";
import { serveMedia } from "../src/mediaWorker.js";

// Files from the media origin (phase 1): signed addresses that last ten to
// twenty minutes, served by a Worker that reads no database, and renewed
// for whoever may still read the file.

const ORG = "personal:mediaorigin";
const KEYS = JSON.stringify({ k1: "a".repeat(64), k0: "b".repeat(64) });
const ON = { ...env, MEDIA_ORIGIN: "https://media.example.com", MEDIA_SIGNING_KEYS: KEYS, MEDIA_SIGNING_KID: "k1" };
let toru; let mika; let kenji; let outsider; let refs;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), ON, ctx);
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

const fetchMedia = (url, init = {}, now = Date.now()) => serveMedia(new Request(url, init), ON, now);

test("off until both the origin and the keys are set, and whenever the flag says off", () => {
  expect(mediaOriginOn(env)).toBe(false);
  expect(mediaOriginOn({ MEDIA_ORIGIN: "https://media.example.com" })).toBe(false);
  expect(mediaOriginOn({ MEDIA_SIGNING_KEYS: KEYS })).toBe(false);
  expect(mediaOriginOn(ON)).toBe(true);
  expect(mediaOriginOn({ ...ON, MEDIA_ORIGIN_V2: "off" })).toBe(false);
  expect(mediaOriginOn({ ...ON, MEDIA_ORIGIN: "http://media.example.com" })).toBe(false);
});

test("a picture sent is shown from the media origin, by an address good for ten to twenty minutes", async () => {
  const up = await (await upload(mika, "b:cafe")).json();
  expect(up.file.url).toMatch(/^https:\/\/media\.example\.com\/f\/k1\//);
  await say(mika, "b:cafe", "look", [up.file.id]);
  const [m] = await list(kenji, "b:cafe");
  const file = m.files[0];
  expect(file.id).toBe(up.file.id);
  const left = file.expiresAt - Date.now();
  expect(left).toBeGreaterThan(WINDOW_SECONDS * 1000 - 5000);
  expect(left).toBeLessThanOrEqual(2 * WINDOW_SECONDS * 1000);
  // The bytes, from a Worker that never asks the database.
  const res = await fetchMedia(file.url);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(res.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  // A video's span, as a player asks.
  const part = await fetchMedia(file.url, { headers: { range: "bytes=0-3" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 0-3/${PNG.byteLength}`);
});

test("an address altered, from another key, or out of its window opens nothing", async () => {
  const up = await (await upload(mika, "b:cafe")).json();
  const good = new URL(up.file.url);
  const now = Date.now();
  const swapped = new URL(good); swapped.searchParams.set("t", "text/html");
  expect((await fetchMedia(swapped.toString())).status).toBe(404);
  const renamed = new URL(good); renamed.searchParams.set("n", "evil.html");
  expect((await fetchMedia(renamed.toString())).status).toBe(404);
  const otherOrg = new URL(good.toString().replace(/\/f\/k1\/[^/]+\//, `/f/k1/${btoa("team:other").replace(/=+$/, "")}/`));
  expect((await fetchMedia(otherOrg.toString())).status).toBe(404);
  const unknownKid = new URL(good.toString().replace("/f/k1/", "/f/zz/"));
  expect((await fetchMedia(unknownKid.toString())).status).toBe(404);
  // Twenty minutes on, it has run out; the window before is still good.
  expect((await fetchMedia(good.toString(), {}, now + 2 * WINDOW_SECONDS * 1000)).status).toBe(404);
  expect((await fetchMedia(good.toString(), {}, now + WINDOW_SECONDS * 1000)).status).toBe(200);
  // An older key still verifies: rotation does not break what is out.
  const old = await signFileUrl({ ...ON, MEDIA_SIGNING_KID: "k0" }, { orgId: ORG, id: up.file.id, type: "image/png", name: "photo.png" });
  expect(old.url).toContain("/f/k0/");
  expect(await verifyFileUrl(ON, new URL(old.url))).toMatchObject({ orgId: ORG, id: up.file.id });
});

test("anything not shown is a download from the media origin too", async () => {
  const up = await (await upload(mika, "b:cafe", { name: "page.html", type: "text/html", bytes: enc("<script>alert(1)</script>") })).json();
  const res = await fetchMedia(up.file.url);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
});

test("new addresses only for files the caller may still read", async () => {
  const pub = await (await upload(mika, "b:cafe")).json();
  await say(mika, "b:cafe", "public", [pub.file.id]);
  const dm = await (await upload(mika, `dm:${refs.Kenji}`)).json();
  await say(mika, `dm:${refs.Kenji}`, "for kenji", [dm.file.id]);
  const unsent = await (await upload(mika, "b:cafe")).json();
  const ask = (token, ids) => call("/media/urls", { method: "POST", headers: auth(token, { "content-type": "application/json" }), body: JSON.stringify({ orgId: ORG, ids }) });
  const forKenji = await (await ask(kenji, [pub.file.id, dm.file.id, unsent.file.id, "f_000000000000000000000000"])).json();
  expect(Object.keys(forKenji.files).sort()).toEqual([dm.file.id, pub.file.id].sort());
  expect(forKenji.files[pub.file.id].url).toMatch(/^https:\/\/media\.example\.com\//);
  // Toru is not in the DM, and the unsent upload is only Mika's.
  const forToru = await (await ask(toru, [pub.file.id, dm.file.id, unsent.file.id])).json();
  expect(Object.keys(forToru.files)).toEqual([pub.file.id]);
  const forMika = await (await ask(mika, [unsent.file.id])).json();
  expect(Object.keys(forMika.files)).toEqual([unsent.file.id]);
  expect((await ask(outsider, [pub.file.id])).status).toBe(403);
});

test("with the media origin off, the API's own addresses come with when to renew them", async () => {
  const res = await worker.fetch(new Request(`https://example.com/channels/files?${q({ orgId: ORG, channel: "b:cafe", name: "p.png", width: 1, height: 1 })}`, {
    method: "POST", headers: auth(mika, { "content-type": "image/png", "content-length": String(PNG.byteLength) }), body: PNG,
  }), env, ctx);
  await settle();
  const { file } = await res.json();
  expect(file.url).toMatch(/^\/files\/f_[0-9a-f]{24}\?e=\d+&s=/);
  expect(file.expiresAt).toBeGreaterThan(Date.now() + 86400000);
});
