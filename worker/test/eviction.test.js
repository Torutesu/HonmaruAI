import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { joined, message, until } from "./helpers.js";

const gone = (ws) => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
const call = (path, token, { method = "GET", body } = {}) => worker.fetch(
  new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", "x-session-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  env
);

// Taking somebody out of a workspace has to take them out of the room.
//
// `att.authed` is written once, at join, and never looked at again — which was
// right when nothing could ever revoke a membership. Now that a workspace can,
// a socket that joined a moment before is the whole of somebody's continued
// access: every card broadcast in that org still reaches them, and they can
// still act, until something else drops the connection.

const TEAM = "personal:evictiontest";
let adminToken;
let guestToken;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "3001", login: "boss", name: "Boss", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "3001", "admin");
  adminToken = await createSession(env.DB, "3001", "gho_boss");

  await upsertUser(env.DB, { githubId: "3002", login: "guest", name: "Guest", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "3002", "member");
  guestToken = await createSession(env.DB, "3002", "gho_guest");
});

test("removing someone closes the socket they are already holding", async () => {
  const { ws, messages } = await joined(TEAM, guestToken);

  const res = await worker.fetch(
    new Request("https://example.com/members", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-session-token": adminToken },
      body: JSON.stringify({ orgId: TEAM, userId: "3002" }),
    }),
    env
  );
  expect(res.status).toBe(200);

  // Told, then closed: 1008 rather than a silent drop, so the client can tell
  // "you are not in this workspace any more" apart from a dead network and
  // stop reconnecting to a door that will not open.
  const refused = await message(messages, (m) => JSON.stringify(m).includes("no longer"));
  expect(refused).toBeTruthy();
  const closed = await until(async () => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING);
  expect(closed).toBeTruthy();
});

test("the people still there keep their sockets", async () => {
  const { ws } = await joined(TEAM, adminToken);
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "3003", login: "passerby", name: "Passerby", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "3003", "member");
  const passerby = await createSession(env.DB, "3003", "gho_passerby");
  const other = await joined(TEAM, passerby);

  await worker.fetch(
    new Request("https://example.com/members", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-session-token": passerby },
      body: JSON.stringify({ orgId: TEAM, userId: "3003" }),
    }),
    env
  );

  // The one who left is gone; the admin watching is untouched.
  await until(async () => other.ws.readyState === WebSocket.CLOSED || other.ws.readyState === WebSocket.CLOSING);
  expect(ws.readyState).toBe(WebSocket.OPEN);
});

test("deleting your account closes the socket it was holding", async () => {
  // The same gap, reached from the other end: the rows saying where somebody
  // worked are deleted, and the connection those rows authorized is not.
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "3004", login: "departing", name: "Departing", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "3004", "member");
  const token = await createSession(env.DB, "3004", "gho_departing");
  const { ws } = await joined(TEAM, token);

  const res = await worker.fetch(
    new Request("https://example.com/account", {
      method: "DELETE",
      headers: { "x-session-token": token },
    }),
    env
  );
  expect(res.status).toBe(200);

  const closed = await until(async () => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING);
  expect(closed).toBeTruthy();
});

// Signing a session out has to sign its sockets out too. The relay checked
// the session once, at join; a device signed out from another one, or by an
// admin, kept hearing the workspace and could still decide its cards.

test("signing one device out closes that device's socket and no other", async () => {
  const { createSession, sessionKey } = await import("../src/db.js");
  const { sessionRef } = await import("../src/sessions.js");
  const phone = await createSession(env.DB, "3002", "gho_guest_phone");
  const laptop = await joined(TEAM, guestToken);
  const lost = await joined(TEAM, phone);

  const res = await call("/sessions", guestToken, { method: "DELETE", body: { ref: await sessionRef(await sessionKey(phone)) } });
  expect((await res.json()).ended).toBe(1);

  expect(await message(lost.messages, (m) => JSON.stringify(m).includes("sign-in-required"))).toBeTruthy();
  expect(await until(async () => gone(lost.ws))).toBe(true);
  expect(laptop.ws.readyState).toBe(WebSocket.OPEN);
});

test("an admin's sign-out closes the member's sockets in that workspace only", async () => {
  const OTHER = "personal:evictiontest-other";
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, OTHER, "3002", "member");
  const here = await joined(TEAM, guestToken);
  const elsewhere = await joined(OTHER, guestToken);
  const watching = await joined(TEAM, adminToken);

  const members = await (await call(`/members?orgId=${encodeURIComponent(TEAM)}`, adminToken)).json();
  const ref = members.members.find((m) => m.name === "Guest").ref;
  const res = await call("/members/sessions", adminToken, { method: "DELETE", body: { orgId: TEAM, ref } });
  expect((await res.json()).ended).toBe(1);

  expect(await message(here.messages, (m) => JSON.stringify(m).includes("session-policy"))).toBeTruthy();
  expect(await until(async () => gone(here.ws))).toBe(true);
  expect(elsewhere.ws.readyState).toBe(WebSocket.OPEN);
  expect(watching.ws.readyState).toBe(WebSocket.OPEN);
});

test("a session ended without a word to the relay is still found out", async () => {
  // A sign-out whose eviction never arrived: the row is gone, the socket is
  // not. The relay's own look at the session is what ends it.
  const { saveCard, getCard, sessionKey } = await import("../src/db.js");
  await saveCard(env.DB, TEAM, {
    id: "c-revoked", recipientUserID: "guest", senderUserID: "boss",
    status: "pending", title: "Sign off the spend", priority: "high", createdAt: "2026-08-11T00:00:00Z",
  });
  const { ws, messages } = await joined(TEAM, guestToken);
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(await sessionKey(guestToken)).run();
  const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(TEAM));
  await runInDurableObject(stub, async (_, state) => {
    for (const socket of state.getWebSockets()) socket.serializeAttachment({ ...socket.deserializeAttachment(), checkedAt: 1 });
  });

  ws.send(JSON.stringify({ type: "tool_result", payload: {
    toolCallId: "t-revoked", content: { cardId: "c-revoked", action: "approve", actorUserID: "guest" },
  } }));
  expect(await message(messages, (m) => JSON.stringify(m).includes("sign-in-required"))).toBeTruthy();
  expect(await until(async () => gone(ws))).toBe(true);
  expect((await getCard(env.DB, TEAM, "c-revoked")).status).toBe("pending");
});

test("the relay's alarm finds a socket whose session ended while it sat idle", async () => {
  const { sessionKey } = await import("../src/db.js");
  const idle = await joined(TEAM, guestToken);
  const kept = await joined(TEAM, adminToken);
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(await sessionKey(guestToken)).run();
  const stub = env.ORG_RELAY.get(env.ORG_RELAY.idFromName(TEAM));
  await runInDurableObject(stub, async (instance, state) => {
    for (const socket of state.getWebSockets()) socket.serializeAttachment({ ...socket.deserializeAttachment(), checkedAt: 1 });
    await instance.alarm();
  });

  expect(await until(async () => gone(idle.ws))).toBe(true);
  expect(kept.ws.readyState).toBe(WebSocket.OPEN);
});
