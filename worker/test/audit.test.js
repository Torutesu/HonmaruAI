import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { listCardEvents } from "../src/events.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

function open(orgId = "audit-org") {
  return SELF.fetch(`https://example.com/?orgId=${orgId}`, {
    headers: { Upgrade: "websocket" },
  }).then((res) => {
    const ws = res.webSocket;
    ws.accept();
    return ws;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function card(id) {
  return {
    id, recipientUserID: "hubot", senderUserID: "octocat", status: "pending",
    title: "Ship it?", priority: "high", createdAt: "2026-08-09T00:00:00Z",
  };
}

test("a decision leaves created + decided, and the snapshot shows the outcome", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-audit") } }));
  await sleep(60);
  ws.send(JSON.stringify({
    type: "tool_result",
    payload: { content: { cardId: "c-audit", action: "approve", actorUserID: "hubot", note: "ok" } },
  }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-audit");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].action).toBe("approve");
  expect(events[1].snapshot.status).toBe("approved");
});

test("a rollback preserves the decision it undid", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-rb") } }));
  await sleep(60);
  ws.send(JSON.stringify({
    type: "tool_result",
    payload: { content: { cardId: "c-rb", action: "approve", actorUserID: "hubot" } },
  }));
  await sleep(60);
  ws.send(JSON.stringify({ type: "rollback", payload: { cardId: "c-rb" } }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-rb");
  const undone = events.find((e) => e.type === "rolled_back");
  expect(undone).toBeTruthy();
  expect(undone.snapshot.decision.action).toBe("approve");
  expect(undone.snapshot.status).toBe("approved");
});

test("deleting a card keeps its history", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-del") } }));
  await sleep(60);
  ws.send(JSON.stringify({ type: "card_deleted", payload: { cardId: "c-del", recipientUserID: "hubot" } }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-del");
  expect(events.map((e) => e.type)).toEqual(["created", "deleted"]);
  const row = await env.DB
    .prepare("SELECT card_id FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind("audit-org", "c-del")
    .first();
  expect(row).toBeNull();
});
