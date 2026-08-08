import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

function open(orgId = "core-team") {
  return SELF.fetch(`https://example.com/?orgId=${orgId}`, {
    headers: { Upgrade: "websocket" },
  }).then((res) => {
    const ws = res.webSocket;
    ws.accept();
    return ws;
  });
}

test("join then a created card round-trips to a second client", async () => {
  const a = await open();
  const b = await open();
  const bMessages = [];
  b.addEventListener("message", (e) => bMessages.push(JSON.parse(e.data)));

  a.send(JSON.stringify({ type: "join", payload: { userId: "user-toru", protocol: "agui/1" } }));
  b.send(JSON.stringify({ type: "join", payload: { userId: "user-yui", protocol: "agui/1" } }));

  a.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-relay", recipientUserID: "user-yui", senderUserID: "user-toru",
    status: "pending", title: "Approve deploy", priority: "high", createdAt: "2026-08-08T00:00:00Z",
  } } }));

  await new Promise((r) => setTimeout(r, 50));
  const delta = bMessages.find((m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("c-relay"));
  expect(delta).toBeTruthy();
});
