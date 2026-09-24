import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A team with a name, made on purpose; an invitation that is a link or an
// email, not only a hex string to read out.

const WEB = { APP_WEB_URL: "https://honmaru-web.pages.dev/" };
const MAIL = { RESEND_API_KEY: "re_test" };
let toru;
let mika;
let outsider;
let sent;

const call = (path, init = {}, over = {}) =>
  worker.fetch(new Request("https://example.com" + path, init), { ...env, ...over }, { waitUntil() {} });
const jsonHeaders = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body, over) => call(path, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) }, over);
const put = (path, token, body, over) => call(path, { method: "PUT", headers: jsonHeaders(token), body: JSON.stringify(body) }, over);
const get = (path, token, over) => call(path, { headers: { "x-session-token": token } }, over);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@x.jp", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "email:mika@x.jp", login: "u:mika@x.jp", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:out@x.jp", login: "u:out@x.jp", name: "Out", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:toru", "email:toru@x.jp", "admin");
  await upsertMembership(env.DB, "personal:out", "email:out@x.jp", "admin");
  toru = await createSession(env.DB, "email:toru@x.jp", "email-auth");
  mika = await createSession(env.DB, "email:mika@x.jp", "email-auth");
  outsider = await createSession(env.DB, "email:out@x.jp", "email-auth");
  sent = [];
  fetchMock.activate();
  fetchMock.get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(200, (opts) => { sent.push(JSON.parse(opts.body)); return { id: "queued" }; })
    .persist();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a team is made with a name, its maker is its admin, and it is listed by that name", async () => {
  let res = await post("/orgs", toru, { name: "  Honmaru   Coffee  " });
  expect(res.status).toBe(200);
  const made = await res.json();
  expect(made.orgId).toMatch(/^team:[0-9a-f]{18}$/);
  expect(made.name).toBe("Honmaru Coffee");

  res = await get("/me", toru);
  const me = await res.json();
  const team = me.orgs.find((o) => o.id === made.orgId);
  expect(team).toMatchObject({ name: "Honmaru Coffee", role: "admin", mine: true });
  // The personal workspace has no name and says so.
  expect(me.orgs.find((o) => o.id === "personal:toru").name).toBeNull();

  res = await get(`/members?orgId=${encodeURIComponent(made.orgId)}`, toru);
  expect(await res.json()).toMatchObject({ name: "Honmaru Coffee", canRename: true, editable: true });

  // No name is no team; a stranger is refused.
  expect((await post("/orgs", toru, { name: "   " })).status).toBe(400);
  expect((await post("/orgs", "nope", { name: "X" })).status).toBe(401);
});

test("an admin renames the team; a member and a repository are refused", async () => {
  const { orgId } = await (await post("/orgs", toru, { name: "Old" })).json();
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, orgId, "email:mika@x.jp", "member");

  let res = await put("/orgs/name", toru, { orgId, name: "New name" });
  expect(res.status).toBe(200);
  expect((await get(`/members?orgId=${encodeURIComponent(orgId)}`, mika)).json()).resolves.toMatchObject({ name: "New name", canRename: false });

  expect((await put("/orgs/name", mika, { orgId, name: "Mine now" })).status).toBe(403);
  expect((await put("/orgs/name", outsider, { orgId, name: "Mine now" })).status).toBe(403);
  expect((await put("/orgs/name", toru, { orgId: "acme/widgets", name: "Widgets" })).status).toBe(400);
  expect((await put("/orgs/name", toru, { orgId, name: "" })).status).toBe(400);
  // The personal workspace can be named too: it is a team the moment
  // somebody else joins it.
  res = await put("/orgs/name", toru, { orgId: "personal:toru", name: "Toru's shop" });
  expect(res.status).toBe(200);
  expect((await get("/me", toru)).json()).resolves.toMatchObject({ orgs: expect.arrayContaining([expect.objectContaining({ id: "personal:toru", name: "Toru's shop" })]) });
});

test("a minted code comes with a link where the web has an address, and the link's page can ask what it opens", async () => {
  let res = await post("/invites/create", toru, { orgId: "personal:toru", role: "engineer" });
  expect((await res.json()).link).toBeNull();

  res = await post("/invites/create", toru, { orgId: "personal:toru", role: "engineer" }, WEB);
  const minted = await res.json();
  expect(minted.link).toBe(`https://honmaru-web.pages.dev/#/join/${minted.code}`);

  res = await get(`/invites/peek?code=${minted.code}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ team: null, inviter: "Toru", role: "engineer", expiresAt: expect.any(String) });
  // Named teams say their name.
  await put("/orgs/name", toru, { orgId: "personal:toru", name: "Honmaru Coffee" });
  expect((await get(`/invites/peek?code=${minted.code}`)).json()).resolves.toMatchObject({ team: "Honmaru Coffee" });

  // A guess answers nothing; a link someone joined by still opens for the
  // next person it was shared with.
  expect((await get("/invites/peek?code=deadbeef")).status).toBe(404);
  expect((await post("/invites/accept", mika, { code: minted.code })).status).toBe(200);
  expect((await get(`/invites/peek?code=${minted.code}`)).status).toBe(200);
});

test("an invitation by email carries the link and the code, in the sender's language, and the code joins", async () => {
  await put("/orgs/name", toru, { orgId: "personal:toru", name: "Honmaru Coffee" });
  let res = await post("/invites/email", toru, { orgId: "personal:toru", email: "New@X.jp", role: "member" }, { ...WEB, ...MAIL });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, role: "member", to: "new@x.jp" });
  expect(sent).toHaveLength(1);
  expect(sent[0].to[0]).toBe("new@x.jp");
  expect(sent[0].subject).toBe("Toruさんから Honmaru AI の「Honmaru Coffee」への招待");
  const link = sent[0].text.match(/https:\/\/honmaru-web\.pages\.dev\/#\/join\/([0-9a-f]{32})/);
  expect(link).not.toBeNull();
  expect(sent[0].text).toContain(link[1]);

  // The code in the mail is a real, single-use invitation.
  res = await post("/invites/accept", mika, { code: link[1] });
  expect(res.status).toBe(200);
  expect((await res.json()).orgId).toBe("personal:toru");
  expect((await post("/invites/accept", outsider, { code: link[1] })).status).toBe(400);

  // Refusals: no mail on this deployment, not an address, not a member.
  expect((await post("/invites/email", toru, { orgId: "personal:toru", email: "a@b.co" }, WEB)).status).toBe(503);
  expect((await post("/invites/email", toru, { orgId: "personal:toru", email: "not-mail" }, MAIL)).status).toBe(400);
  expect((await post("/invites/email", outsider, { orgId: "personal:toru", email: "a@b.co" }, MAIL)).status).toBe(403);
  expect(sent).toHaveLength(1);
});

test("an invitation the mail could not carry leaves no code behind", async () => {
  // The persisted 200 interceptor above answers Resend's real origin, so
  // fail by env: a base nothing answers.
  const res = await post("/invites/email", toru, { orgId: "personal:toru", email: "a@b.co" }, { ...MAIL, RESEND_API_BASE: "https://mail.down.example" });
  expect(res.status).toBe(502);
  const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites").all();
  expect(Number(results[0].n)).toBe(0);
});
