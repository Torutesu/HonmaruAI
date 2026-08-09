import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, upsertMembership } from "../src/db.js";
import { appendCardEvent } from "../src/events.js";

let memberToken;
let strangerToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  memberToken = await createSession(env.DB, "501", "gho_member");
  strangerToken = await createSession(env.DB, "502", "gho_stranger");
  await upsertMembership(env.DB, "acme/web", "501", "Engineer");
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c-api", type: "created", actorUserId: "octocat", snapshot: { id: "c-api" },
  });
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c-api", type: "decided", action: "approve", actorUserId: "hubot",
    snapshot: { id: "c-api", status: "approved" },
  });
});

test("a member reads a card timeline oldest-first", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/cards/c-api/events", {
    headers: { "x-session-token": memberToken },
  });
  expect(res.status).toBe(200);
  const { events } = await res.json();
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
});

test("a member reads the org activity newest-first", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events?limit=10", {
    headers: { "x-session-token": memberToken },
  });
  expect(res.status).toBe(200);
  const { events } = await res.json();
  expect(events[0].type).toBe("decided");
});

test("a signed-in non-member is refused", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events", {
    headers: { "x-session-token": strangerToken },
  });
  expect(res.status).toBe(403);
});

test("no session is refused", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events");
  expect(res.status).toBe(401);
});
