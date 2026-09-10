import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { joined, message, until } from "./helpers.js";

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

beforeAll(async () => {
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
