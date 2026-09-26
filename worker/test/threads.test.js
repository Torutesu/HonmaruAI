import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { mentionTokens, resolveMentions } from "../src/threads.js";
import { joined, until } from "./helpers.js";

// The conversation around a decision: a thread of comments, @mentions that
// reach the person named, one-emoji reactions. All of it inside one
// workspace, and none of it readable from another.

const ORG = "team:cccccccccccccccccc";
const OTHER = "team:dddddddddddddddddd";
let toru, mika, out, sent;
const call = (path, init = {}, over = {}) =>
  worker.fetch(new Request("https://example.com" + path, init), { ...env, ...over }, { waitUntil() {} });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const get = (path, token, over) => call(path, { headers: { "x-session-token": token } }, over);
const post = (path, token, body, over) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, over);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard, setUserAliases } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@x.jp", login: "u:toru@x.jp", name: "Toru Bando", avatarUrl: null, locale: "ja", email: "toru@x.jp" });
  await upsertUser(env.DB, { githubId: "email:mika@x.jp", login: "u:mika@x.jp", name: "Mika Sato", avatarUrl: null, locale: "en", email: "mika@x.jp" });
  await upsertUser(env.DB, { githubId: "email:out@x.jp", login: "u:out@x.jp", name: "Out", avatarUrl: null, locale: "en" });
  await setUserAliases(env.DB, "email:mika@x.jp", ["美香"]);
  await env.DB.prepare("UPDATE users SET email = 'toru@x.jp' WHERE github_id = 'email:toru@x.jp'").run();
  await env.DB.prepare("UPDATE users SET email = 'mika@x.jp' WHERE github_id = 'email:mika@x.jp'").run();
  for (const id of ["email:toru@x.jp", "email:mika@x.jp"]) await upsertMembership(env.DB, ORG, id, "member");
  await upsertMembership(env.DB, OTHER, "email:out@x.jp", "admin");
  toru = await createSession(env.DB, "email:toru@x.jp", "email-auth");
  mika = await createSession(env.DB, "email:mika@x.jp", "email-auth");
  out = await createSession(env.DB, "email:out@x.jp", "email-auth");
  await saveCard(env.DB, ORG, {
    id: "c1", recipientUserID: "u:mika@x.jp", senderUserID: "u:toru@x.jp",
    status: "pending", title: "Approve the spring menu", priority: "medium", createdAt: "2026-09-20T00:00:00Z",
  });
  sent = [];
  fetchMock.activate();
  fetchMock.get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(200, (opts) => { sent.push(JSON.parse(opts.body)); return { id: "queued" }; })
    .persist();
});
afterEach(() => fetchMock.deactivate());

test("@ tokens are read out of a sentence, in any script", () => {
  expect(mentionTokens("@Kenji, can you approve? cc @美香 (and @mika.s)")).toEqual(["Kenji", "美香", "mika.s"]);
  expect(mentionTokens("mail me at toru@x.jp")).toEqual([]);
});

test("a mention resolves by name, first name, handle or alias — and only to members", () => {
  const members = [
    { login: "u:toru@x.jp", ref: "r1", name: "Toru Bando", aliases: [] },
    { login: "u:mika@x.jp", ref: "r2", name: "Mika Sato", aliases: ["美香"] },
  ];
  expect(resolveMentions("@Mika what do you think", members).map((m) => m.login)).toEqual(["u:mika@x.jp"]);
  expect(resolveMentions("@美香 見て", members).map((m) => m.login)).toEqual(["u:mika@x.jp"]);
  expect(resolveMentions("@toru and @r2", members).map((m) => m.login)).toEqual(["u:toru@x.jp", "u:mika@x.jp"]);
  expect(resolveMentions("@everyone look", members)).toEqual([]);
});

test("a comment lands in the thread, counts on the card, and reaches the people it concerns", async () => {
  const res = await post("/cards/c1/comments", toru, { orgId: ORG, body: "@Mika the supplier confirmed the price." }, { RESEND_API_KEY: "re_test", NOTIFY_EMAIL_FROM: "Honmaru <no-reply@x.jp>" });
  expect(res.status).toBe(201);
  const { comment, card } = await res.json();
  expect(comment.author).toBe("u:toru@x.jp");
  expect(comment.authorName).toBe("Toru Bando");
  expect(comment.mentions).toEqual(["u:mika@x.jp"]);
  expect(card.commentCount).toBe(1);
  expect(card.lastCommentAt).toBe(comment.createdAt);

  const listed = await (await get(`/cards/c1/comments?orgId=${encodeURIComponent(ORG)}`, mika)).json();
  expect(listed.comments).toHaveLength(1);
  expect(listed.comments[0].body).toBe("@Mika the supplier confirmed the price.");

  // Logged, so the card's history shows it.
  const events = await (await get(`/cards/c1/events?orgId=${encodeURIComponent(ORG)}`, mika)).json();
  expect(events.events.some((e) => e.type === "commented" && e.actorUserId === "u:toru@x.jp")).toBe(true);

  // Mika was mentioned, so she is told once, as a mention; Toru wrote it and is not.
  await until(() => sent.length >= 1);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toContain("mika@x.jp");
  expect(sent[0].text).toContain("Toru Bando");
  expect(sent[0].text).toContain("supplier confirmed");
});

test("a comment on a card with nobody mentioned still reaches the other party", async () => {
  const res = await post("/cards/c1/comments", mika, { orgId: ORG, body: "Looking now." }, { RESEND_API_KEY: "re_test", NOTIFY_EMAIL_FROM: "Honmaru <no-reply@x.jp>" });
  expect(res.status).toBe(201);
  await until(() => sent.length >= 1);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toContain("toru@x.jp");
});

test("an empty or oversized comment is refused", async () => {
  expect((await post("/cards/c1/comments", toru, { orgId: ORG, body: "   " })).status).toBe(400);
  expect((await post("/cards/c1/comments", toru, { orgId: ORG, body: "x".repeat(2001) })).status).toBe(400);
  expect((await post("/cards/nope/comments", toru, { orgId: ORG, body: "hi" })).status).toBe(404);
});

test("a reaction toggles, counts on the card, and says whether it is yours", async () => {
  let res = await post("/cards/c1/reactions", mika, { orgId: ORG, emoji: "👍" });
  expect(res.status).toBe(200);
  let data = await res.json();
  expect(data.on).toBe(true);
  expect(data.card.reactions).toEqual({ "👍": 1 });
  expect(data.reactions).toEqual([{ emoji: "👍", count: 1, mine: true, names: ["Mika Sato"] }]);
  res = await post("/cards/c1/reactions", toru, { orgId: ORG, emoji: "👍" });
  data = await res.json();
  expect(data.card.reactions).toEqual({ "👍": 2 });
  expect(data.reactions[0]).toMatchObject({ count: 2, mine: true });
  res = await post("/cards/c1/reactions", mika, { orgId: ORG, emoji: "👍" });
  data = await res.json();
  expect(data.on).toBe(false);
  expect(data.card.reactions).toEqual({ "👍": 1 });
  expect((await post("/cards/c1/reactions", mika, { orgId: ORG, emoji: "💣" })).status).toBe(400);
});

test("open sockets in the workspace hear a comment as it lands; another workspace does not", async () => {
  const { messages: room } = await joined(ORG, mika);
  const { messages: elsewhere } = await joined(OTHER, out);
  const res = await post("/cards/c1/comments", toru, { orgId: ORG, body: "Done." });
  expect(res.status).toBe(201);
  const heard = await until(() => room.find((m) => m.type === "CUSTOM" && m.name === "comment" && m.value?.comment?.body === "Done."));
  expect(heard).toBeTruthy();
  const counted = await until(() => room.find((m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes('"commentCount":1')));
  expect(counted).toBeTruthy();
  expect(JSON.stringify(elsewhere)).not.toContain("Done.");
});

test("nothing of a thread is readable or writable from another workspace", async () => {
  expect((await get(`/cards/c1/comments?orgId=${encodeURIComponent(ORG)}`, out)).status).toBe(403);
  expect((await post("/cards/c1/comments", out, { orgId: ORG, body: "hi" })).status).toBe(403);
  expect((await post("/cards/c1/reactions", out, { orgId: ORG, emoji: "👍" })).status).toBe(403);
});

test("one @mention names the recipient of an instruction", async () => {
  const { listMembers } = await import("../src/team.js");
  const members = await listMembers(env.DB, ORG, null);
  const mikaRef = members.find((m) => m.login === "u:mika@x.jp").ref;
  const res = await post("/ai/route", toru, { text: "@Mika approve the autumn menu", orgId: ORG, mentions: [mikaRef] });
  expect(res.status).toBe(200);
  expect((await res.json()).recipientUserID).toBe("u:mika@x.jp");
  // A ref that names nobody in the workspace is refused, not guessed.
  const bad = await post("/ai/route", toru, { text: "@Nobody approve it", orgId: ORG, mentions: ["not-a-ref"] });
  expect(bad.status).toBe(400);
});
