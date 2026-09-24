import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A workspace's own mark: set by its admins, seen by everyone in it, and
// listed with every workspace a person can switch to.

const ORG = "team:ffffffffffffffffff";
let toru, mika;
const call = (path, init = {}) => worker.fetch(new Request("https://example.com" + path, init), env, { waitUntil() {} });
const get = (path, token) => call(path, { headers: { "x-session-token": token } });
// The smallest PNG there is: one transparent pixel.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@x.jp", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "email:mika@x.jp", login: "u:mika@x.jp", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "email:toru@x.jp", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@x.jp", "member");
  toru = await createSession(env.DB, "email:toru@x.jp", "email-auth");
  mika = await createSession(env.DB, "email:mika@x.jp", "email-auth");
});

test("an admin sets the logo; everyone sees it; a member may not set it", async () => {
  let res = await call(`/orgs/icon?orgId=${encodeURIComponent(ORG)}`, {
    method: "POST", headers: { "x-session-token": mika, "content-type": "image/png" }, body: PNG,
  });
  expect(res.status).toBe(403);
  res = await call(`/orgs/icon?orgId=${encodeURIComponent(ORG)}`, {
    method: "POST", headers: { "x-session-token": toru, "content-type": "image/png" }, body: PNG,
  });
  expect(res.status).toBe(200);
  const { icon } = await res.json();
  expect(icon).toMatch(/^https:\/\/example\.com\/orgs\/icon\/org-icon-/);

  // Served as an image, from an id nobody can guess, to anyone holding it.
  const served = await call(new URL(icon).pathname);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

  // On the team screen and in the list of workspaces to switch to.
  expect((await (await get(`/members?orgId=${encodeURIComponent(ORG)}`, mika)).json()).icon).toBe(icon);
  const me = await (await get("/me", mika)).json();
  expect(me.orgs.find((o) => o.id === ORG).icon).toBe(icon);

  // Removed: gone from both, and the bytes with it.
  res = await call(`/orgs/icon?orgId=${encodeURIComponent(ORG)}`, { method: "DELETE", headers: { "x-session-token": toru } });
  expect(res.status).toBe(200);
  expect((await (await get(`/members?orgId=${encodeURIComponent(ORG)}`, mika)).json()).icon).toBeNull();
  expect((await call(new URL(icon).pathname)).status).toBe(404);
});

test("a logo is an image, and not a big one", async () => {
  let res = await call(`/orgs/icon?orgId=${encodeURIComponent(ORG)}`, {
    method: "POST", headers: { "x-session-token": toru, "content-type": "image/svg+xml" }, body: "<svg/>",
  });
  expect(res.status).toBe(415);
  res = await call(`/orgs/icon?orgId=${encodeURIComponent(ORG)}`, {
    method: "POST", headers: { "x-session-token": toru, "content-type": "image/png", "content-length": String(3 * 1024 * 1024) }, body: PNG,
  });
  expect(res.status).toBe(413);
});
