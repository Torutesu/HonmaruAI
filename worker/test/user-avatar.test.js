import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Everyone's own face, beside what they write.

const ORG = "personal:faces";
let toru;
const call = (path, token, init = {}) => worker.fetch(new Request("https://example.com" + path, {
  ...init, headers: { "x-session-token": token, ...(init.headers || {}) },
}), env, { waitUntil: () => {} });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9601", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "9602", login: "octo", name: "Octo", avatarUrl: "https://avatars.githubusercontent.com/u/1", locale: "en" });
  await upsertMembership(env.DB, ORG, "9601", "admin");
  await upsertMembership(env.DB, ORG, "9602", "member");
  toru = await createSession(env.DB, "9601", "gho_t");
});

test("a photo uploaded is served back, named on /me, and shown with every member", async () => {
  const up = await call("/me/avatar", toru, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
  expect(up.status).toBe(200);
  const { avatarUrl } = await up.json();
  expect(avatarUrl).toMatch(/^https:\/\/example\.com\/users\/avatar\/user-avatar-[0-9a-f-]{36}$/);
  const served = await worker.fetch(new Request(avatarUrl), env);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  expect((await (await call("/me", toru)).json()).avatarUrl).toBe(avatarUrl);
  const { members } = await (await call(`/channels?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(members.find((m) => m.name === "Toru").avatarUrl).toBe(avatarUrl);
  // A GitHub account keeps its GitHub face.
  expect(members.find((m) => m.name === "Octo").avatarUrl).toBe("https://avatars.githubusercontent.com/u/1");
});

test("a signed-in upsert keeps an uploaded photo; removing it clears it; SVG is refused", async () => {
  const { avatarUrl } = await (await call("/me/avatar", toru, { method: "POST", headers: { "content-type": "image/png" }, body: PNG })).json();
  const { upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9601", login: "u:toru@x.jp", name: "Toru", avatarUrl: null });
  expect((await (await call("/me", toru)).json()).avatarUrl).toBe(avatarUrl);
  expect((await call("/me/avatar", toru, { method: "POST", headers: { "content-type": "image/svg+xml" }, body: "<svg/>" })).status).toBe(415);
  expect((await call("/me/avatar", toru, { method: "DELETE" })).status).toBe(200);
  expect((await (await call("/me", toru)).json()).avatarUrl).toBe(null);
  expect((await worker.fetch(new Request(avatarUrl), env)).status).toBe(404);
});
