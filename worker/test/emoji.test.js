import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import party from "./fixtures/shogun_party.svg?raw";
import worker from "../src/index.js";
import { svgProblem, cleanEmojiName } from "../src/emoji.js";

// A workspace's own emoji: its members add them, use them, and only that
// workspace has them.

const SHOGUN = "personal:shogun";
const OTHER = "personal:other";
let toru; let mika; let ann;
const ctx = { waitUntil: () => {} };
const call = (path, token, { method = "GET", body, type } = {}) => worker.fetch(new Request(`https://example.com${path}`, {
  method, headers: { "x-session-token": token, ...(type ? { "content-type": type } : {}) }, body,
}), env, ctx);
const add = (token, org, name, bytes, type) => call(`/emoji?orgId=${encodeURIComponent(org)}&name=${encodeURIComponent(name)}`, token, { method: "POST", body: bytes, type });
const list = async (token, org) => (await (await call(`/emoji?orgId=${encodeURIComponent(org)}`, token)).json()).emoji;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name] of [["7701", "toru", "Toru"], ["7702", "mika", "Mika"], ["7703", "ann", "Ann"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
  }
  await upsertMembership(env.DB, SHOGUN, "7701", "admin");
  await upsertMembership(env.DB, SHOGUN, "7702", "member");
  await upsertMembership(env.DB, OTHER, "7703", "admin");
  toru = await createSession(env.DB, "7701", "gho_t");
  mika = await createSession(env.DB, "7702", "gho_m");
  ann = await createSession(env.DB, "7703", "gho_a");
});

test("a member adds an animated SVG, and only that workspace has it", async () => {
  const res = await add(mika, SHOGUN, "shogun_party", party, "image/svg+xml");
  expect(res.status).toBe(201);
  const { emoji } = await res.json();
  expect(emoji).toMatchObject({ name: "shogun_party", by: "mika", url: expect.stringMatching(/\/emoji\/img\/emoji-[0-9a-f-]{36}$/) });
  expect((await list(toru, SHOGUN)).map((e) => e.name)).toEqual(["shogun_party"]);
  // Another workspace sees none of it, and cannot ask.
  expect(await list(ann, OTHER)).toEqual([]);
  expect((await call(`/emoji?orgId=${encodeURIComponent(SHOGUN)}`, ann)).status).toBe(403);
  expect((await add(ann, SHOGUN, "x", PNG, "image/png")).status).toBe(403);

  // Served as a picture that runs nothing.
  const img = await call(new URL(emoji.url).pathname, "");
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/svg+xml");
  expect(img.headers.get("content-security-policy")).toContain("sandbox");
  expect(img.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await img.text()).toContain("ShogunAI party");
});

test("names are one per workspace; the adder or an admin removes one", async () => {
  expect((await add(toru, SHOGUN, "Ship It.png", PNG, "image/png")).status).toBe(201);
  expect((await list(toru, SHOGUN)).map((e) => e.name)).toEqual(["ship_it"]);
  expect((await add(mika, SHOGUN, "ship_it", PNG, "image/png")).status).toBe(409);
  // The same name in another workspace is its own.
  expect((await add(ann, OTHER, "ship_it", PNG, "image/png")).status).toBe(201);
  expect((await add(mika, SHOGUN, "mine", PNG, "image/png")).status).toBe(201);
  expect((await call(`/emoji?orgId=${encodeURIComponent(SHOGUN)}&name=ship_it`, mika, { method: "DELETE" })).status).toBe(403);
  expect((await call(`/emoji?orgId=${encodeURIComponent(SHOGUN)}&name=mine`, mika, { method: "DELETE" })).status).toBe(200);
  expect((await call(`/emoji?orgId=${encodeURIComponent(SHOGUN)}&name=ship_it`, toru, { method: "DELETE" })).status).toBe(200);
  expect(await list(toru, SHOGUN)).toEqual([]);
  expect((await list(ann, OTHER)).map((e) => e.name)).toEqual(["ship_it"]);
});

test("only pictures, and an SVG only if it is only a picture", async () => {
  expect((await add(toru, SHOGUN, "page", "<html></html>", "text/html")).status).toBe(415);
  const bad = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.example/t)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.example/a.css";</style></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="javascript:alert(1)"/></svg>',
  ];
  for (const svg of bad) {
    expect(svgProblem(svg)).not.toBeNull();
    expect((await add(toru, SHOGUN, "bad", svg, "image/svg+xml")).status).toBe(400);
  }
  expect(svgProblem(party)).toBeNull();
  expect(svgProblem('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>')).toBeNull();
  expect(await list(toru, SHOGUN)).toEqual([]);
});

test("a name from a file name", () => {
  expect(cleanEmojiName("shogun_party.svg")).toBe("shogun_party");
  expect(cleanEmojiName(":LGTM:")).toBe("lgtm");
  expect(cleanEmojiName("日本語")).toBeNull();
});
