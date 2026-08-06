// Smoke test: boots the real server, drives two WS clients through the
// core flow (hello -> instruction -> card_action), then verifies resume.
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const config: Config = {
  port: 18099,
  databasePath: ":memory:",
  logLevel: "silent",
  sessionTtlDays: 30,
  authDevMode: true,
  github: { clientId: "", clientSecret: "", redirectUri: "" },
  openRouter: null,
};

const app = createApp(config);
const server = serve({ fetch: app.http.fetch, port: config.port }) as Server;
app.hub.attach(server);

const base = `http://127.0.0.1:${config.port}`;

async function post(path: string, token: string | null, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data as Record<string, any>;
}

function connect(token: string, orgId: string, sinceSeq?: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  const received: any[] = [];
  ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
  return new Promise<{ ws: WebSocket; received: any[] }>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", token, orgId, sinceSeq }));
      setTimeout(() => resolve({ ws, received }), 300);
    });
    ws.on("error", reject);
  });
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alice = await post("/v1/auth/dev", null, { name: "Alice" });
const bob = await post("/v1/auth/dev", null, { name: "Bob" });
const org = await post("/v1/orgs", alice.token, { name: "Acme", title: "PM" });
const orgId = org.org.id;
const invite = await post(`/v1/orgs/${orgId}/invites`, alice.token, {});
await post("/v1/invites/accept", bob.token, { code: invite.code, title: "Engineer" });

const aliceConn = await connect(alice.token, orgId);
const bobConn = await connect(bob.token, orgId);

assert(aliceConn.received.find((m) => m.type === "welcome"), "alice got welcome");
assert(bobConn.received.find((m) => m.type === "snapshot"), "bob got snapshot");
assert(
  aliceConn.received.find((m) => m.type === "presence" && m.status === "online"),
  "alice saw bob come online"
);

// Alice sends an instruction; Bob must receive the card as an event.
aliceConn.ws.send(
  JSON.stringify({
    type: "instruction",
    clientRef: "ref-1",
    text: "tell Bob to fix the login bug urgently",
  })
);
await wait(400);

const ack = aliceConn.received.find((m) => m.type === "ack" && m.clientRef === "ref-1");
assert(ack?.card?.recipientUserId === bob.user.id, "instruction acked, routed to Bob");
const bobEvent = bobConn.received.find((m) => m.type === "event" && m.event.type === "card_created");
assert(bobEvent, "bob received card_created event");
const cardId = bobEvent.event.payload.card.id;

// Bob approves; Alice must see the update.
bobConn.ws.send(
  JSON.stringify({ type: "card_action", clientRef: "ref-2", cardId, action: "approve" })
);
await wait(400);
const aliceUpdate = aliceConn.received.find(
  (m) => m.type === "event" && m.event.type === "card_updated"
);
assert(
  aliceUpdate?.event.payload.card.status === "approved",
  "alice saw approval reflected back"
);

// Unauthorized action: Alice tries to approve on Bob's behalf -> error frame.
aliceConn.ws.send(
  JSON.stringify({ type: "card_action", clientRef: "ref-3", cardId, action: "approve" })
);
await wait(300);
assert(
  aliceConn.received.find((m) => m.type === "error" && m.clientRef === "ref-3"),
  "non-recipient action rejected"
);

// Resume: reconnect Bob with the seq from before the approval, expect replay.
const seqBeforeApproval = bobEvent.event.seq;
bobConn.ws.close();
await wait(200);
const bobResume = await connect(bob.token, orgId, seqBeforeApproval);
const replayed = bobResume.received.filter((m) => m.type === "event");
assert(
  replayed.some((m) => m.event.type === "card_updated" && m.event.seq > seqBeforeApproval),
  "resume replayed events after cursor"
);

// Bad token is rejected.
const badWs = new WebSocket(`ws://127.0.0.1:${config.port}`);
await new Promise<void>((resolve) => {
  badWs.on("open", () => {
    badWs.send(JSON.stringify({ type: "hello", token: "nope", orgId }));
  });
  badWs.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    assert(message.type === "error" && message.code === "unauthorized", "bad token rejected");
    resolve();
  });
});

console.log("ALL SMOKE CHECKS PASSED");
aliceConn.ws.close();
bobResume.ws.close();
badWs.close();
server.close();
app.close();
process.exit(0);
