import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { inviteCodeFrom } from "../src/auth.js";

// An invitation is a link that works for three days. The code is inside the
// link; every endpoint reads it out of whatever was pasted.

const WEB = { APP_WEB_URL: "https://honmaru-web.pages.dev/" };
let toru, mika;
const call = (path, init = {}, over = {}) =>
  worker.fetch(new Request("https://example.com" + path, init), { ...env, ...WEB, ...over }, { waitUntil() {} });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const get = (path, token) => call(path, { headers: { "x-session-token": token } });
const post = (path, token, body) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@x.jp", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "email:mika@x.jp", login: "u:mika@x.jp", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:toru", "email:toru@x.jp", "admin");
  await upsertMembership(env.DB, "personal:mika", "email:mika@x.jp", "admin");
  toru = await createSession(env.DB, "email:toru@x.jp", "email-auth");
  mika = await createSession(env.DB, "email:mika@x.jp", "email-auth");
});

test("the code is read out of a link, a bare code, or one with spaces around it", () => {
  const code = "0123456789abcdef0123456789abcdef";
  expect(inviteCodeFrom(`https://honmaru-web.pages.dev/#/join/${code}`)).toBe(code);
  expect(inviteCodeFrom(`  ${code.toUpperCase()}  `)).toBe(code);
  expect(inviteCodeFrom(code)).toBe(code);
  expect(inviteCodeFrom("")).toBe("");
});

test("a minted invitation is a link that lasts three days, and the list carries it", async () => {
  const res = await post("/invites/create", toru, { orgId: "personal:toru", role: "member" });
  expect(res.status).toBe(200);
  const minted = await res.json();
  expect(minted.link).toMatch(/^https:\/\/honmaru-web\.pages\.dev\/#\/join\/[0-9a-f]{32}$/);
  const ttl = new Date(minted.expiresAt).getTime() - Date.now();
  expect(ttl).toBeGreaterThan(2.9 * 24 * 3600 * 1000);
  expect(ttl).toBeLessThan(3.1 * 24 * 3600 * 1000);

  const listed = await (await get("/invites?orgId=personal%3Atoru", toru)).json();
  expect(listed.invites).toHaveLength(1);
  expect(listed.invites[0].link).toBe(minted.link);
});

test("a pasted link joins, the same as its code would", async () => {
  const minted = await (await post("/invites/create", toru, { orgId: "personal:toru", role: "member" })).json();
  const res = await post("/invites/accept", mika, { code: minted.link });
  expect(res.status).toBe(200);
  expect((await res.json()).orgId).toBe("personal:toru");
});

test("a link older than three days is dead", async () => {
  const minted = await (await post("/invites/create", toru, { orgId: "personal:toru", role: "member" })).json();
  await env.DB.prepare("UPDATE invites SET expires_at = ?1 WHERE code = ?2")
    .bind(new Date(Date.now() - 1000).toISOString(), minted.code).run();
  const res = await post("/invites/accept", mika, { code: minted.link });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/expired|not valid/);
  expect((await call(`/invites/peek?code=${encodeURIComponent(minted.link)}`)).status).toBe(404);
});
