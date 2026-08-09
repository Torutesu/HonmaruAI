import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { appendCardEvent, listCardEvents, listOrgEvents } from "../src/events.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("a card's events read back oldest-first with their payload", async () => {
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c1", type: "created", actorUserId: "octocat",
    snapshot: { id: "c1", status: "pending" },
  });
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c1", type: "decided", action: "approve", actorUserId: "hubot",
    note: "lgtm", snapshot: { id: "c1", status: "approved" },
  });

  const events = await listCardEvents(env.DB, "acme/web", "c1");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].action).toBe("approve");
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].note).toBe("lgtm");
  expect(events[1].snapshot.status).toBe("approved");
});

test("org events are newest-first and never leak another org", async () => {
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c2", type: "created", actorUserId: "octocat",
    snapshot: { id: "c2", status: "pending" },
  });
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c2", type: "decided", action: "approve", actorUserId: "hubot",
    note: "lgtm", snapshot: { id: "c2", status: "approved" },
  });
  await appendCardEvent(env.DB, "other/repo", {
    cardId: "x1", type: "created", snapshot: { id: "x1" },
  });
  const mine = await listOrgEvents(env.DB, "acme/web", 50);
  expect(mine.every((e) => e.cardId !== "x1")).toBe(true);
  expect(mine[0].type).toBe("decided");
});
