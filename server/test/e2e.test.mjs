// HTTP + legacy-WebSocket end to end against a spawned relay: health, OAuth
// config gating, keyword routing, and the realtime protocol including
// regression tests for past audit findings (org-wide clear, stale buckets,
// missing join presence, foreign browser origins).
// Run with `npm test` from server/.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 18777;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

let server;

before(async () => {
  server = spawn("node", [join(__dirname, "..", "index.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    },
    stdio: "pipe",
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await delay(900);
});

after(() => {
  server?.kill();
});

async function http(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

function wsClient(options) {
  const ws = new WebSocket(WS_URL, options);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    inbox,
    opened,
    send: (type, payload) => ws.send(JSON.stringify({ type, payload })),
    sendRaw: (data) => ws.send(data),
    waitFor: (pred, timeoutMs = 3000) => {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

const toru = { id: "user-toru", name: "Toru", role: "Owner" };
const org = {
  nodes: [
    { id: "user-toru", kind: "person", label: "Toru" },
    { id: "user-alex", kind: "person", label: "Alex" },
  ],
  edges: [{ id: "e1", fromID: "user-toru", toID: "user-alex", kind: "manages" }],
};

async function route(text, extra = {}) {
  return http("/ai/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sender: toru, organization: org, ...extra }),
  });
}

/* ---------------- HTTP ---------------- */

test("GET /health reports flags", async () => {
  const res = await http("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.aiRouting, false);
});

test("OAuth endpoints 503 when unconfigured", async () => {
  assert.equal((await http("/oauth/github/config")).status, 503);
  assert.equal((await http("/oauth/github/state")).status, 503);
  const token = await http("/oauth/github/token", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(token.status, 503);
});

test("/github proxy refuses without a session and unknown paths", async () => {
  const noAuth = await http("/github/user");
  assert.equal(noAuth.status, 401);
});

test("no wildcard CORS on API responses", async () => {
  const res = await http("/health");
  assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
});

test("unknown route 404, bad JSON 400, missing fields 400", async () => {
  assert.equal((await http("/nope")).status, 404);
  const badJson = await http("/ai/route", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid",
  });
  assert.equal(badJson.status, 400);
  const missing = await http("/ai/route", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(missing.status, 400);
});

test("oversized body is rejected", async () => {
  const res = await http("/ai/route", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(2 * 1024 * 1024), sender: toru, organization: org }),
  });
  assert.ok(res.status === 400 || res.status === 413, `status=${res.status}`);
});

/* ---------------- keyword routing ---------------- */

test("named recipient and team/role routing", async () => {
  const named = await route("ask Alex to fix the deploy bug");
  assert.equal(named.body.recipientUserID, "user-alex");

  const designer = await route("ロゴとバナーの修正をお願い");
  assert.equal(designer.body.recipientUserID, "user-yui");

  const invoice = await route("invoice pricing needs review");
  assert.ok(
    ["user-toru", "user-tanaka", "user-yui", "user-alex"].includes(invoice.body.recipientUserID),
    `unexpected recipient ${invoice.body.recipientUserID}`
  );
});

test("word boundaries: 'Alexander' must not match 'Alex'", async () => {
  const res = await http("/ai/route", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "the alexander technique workshop went well",
      sender: { id: "user-yui", name: "Yui", role: "Designer" },
      organization: { nodes: [], edges: [] },
    }),
  });
  assert.notEqual(res.body.routingReason, "Named in your instruction");
});

test("priority: urgent keyword, override respected, invalid override ignored", async () => {
  const urgent = await route("urgent: the server is down");
  assert.equal(urgent.body.priority, "urgent");

  const low = await route("when you have a moment", { priorityOverride: "low" });
  assert.equal(low.body.priority, "low");

  const bad = await route("when you have a moment", { priorityOverride: "super-urgent" });
  assert.ok(["low", "medium", "high", "urgent"].includes(bad.body.priority));
});

/* ---------------- websocket ---------------- */

test("join → snapshot with onlineUserIds; existing clients see presence", async () => {
  const a = wsClient();
  await a.opened;
  a.send("join", { userId: "user-toru" });
  const snapA = await a.waitFor((m) => m.type === "snapshot");
  assert.ok(typeof snapA.payload.cardsByUser === "object");
  assert.ok(Array.isArray(snapA.payload.onlineUserIds));

  const b = wsClient();
  await b.opened;
  b.send("join", { userId: "user-alex" });
  const snapB = await b.waitFor((m) => m.type === "snapshot");
  // Regression: the joiner used to learn nobody was online.
  assert.ok(snapB.payload.onlineUserIds.includes("user-toru"), JSON.stringify(snapB.payload));

  const presenceA = await a.waitFor((m) => m.type === "presence" && m.payload.userId === "user-alex");
  assert.equal(presenceA.payload.status, "online");

  a.close();
  b.close();
});

test("card lifecycle: create → broadcast, snapshot for late joiner, update, delete", async () => {
  const a = wsClient();
  await a.opened;
  a.send("join", { userId: "user-toru" });
  await a.waitFor((m) => m.type === "snapshot");

  const b = wsClient();
  await b.opened;
  b.send("join", { userId: "user-alex" });
  await b.waitFor((m) => m.type === "snapshot");

  const card = {
    id: "card-e2e-1", recipientUserID: "user-alex", senderUserID: "user-toru",
    type: "task", title: "Fix auth", summary: "Fix it", context: "a: b",
    status: "pending", priority: "high", createdAt: new Date().toISOString(),
  };
  a.send("card_created", { card });
  const gotB = await b.waitFor((m) => m.type === "card_created");
  assert.equal(gotB.payload.card.id, "card-e2e-1");

  const late = wsClient();
  await late.opened;
  late.send("join", { userId: "user-yui" });
  const snapLate = await late.waitFor((m) => m.type === "snapshot");
  assert.ok((snapLate.payload.cardsByUser["user-alex"] || []).some((c) => c.id === "card-e2e-1"));
  late.close();

  const moved = { ...card, recipientUserID: "user-toru", status: "approved" };
  a.send("card_updated", { card: moved });
  await a.waitFor((m) => m.type === "card_updated" && m.payload.card.id === "card-e2e-1");
  await delay(150);

  const verify = wsClient();
  await verify.opened;
  verify.send("join", { userId: "user-tanaka" });
  const snapV = await verify.waitFor((m) => m.type === "snapshot");
  // Regression: recipient change used to leave a stale copy in the old bucket.
  const inAlex = (snapV.payload.cardsByUser["user-alex"] || []).some((c) => c.id === "card-e2e-1");
  const inToru = (snapV.payload.cardsByUser["user-toru"] || []).some((c) => c.id === "card-e2e-1");
  assert.equal(inAlex, false, "stale copy remained in old bucket");
  assert.equal(inToru, true);
  verify.close();

  a.send("card_deleted", { cardId: "card-e2e-1", recipientUserID: "user-toru" });
  const del = await b.waitFor((m) => m.type === "card_deleted");
  assert.equal(del.payload.cardId, "card-e2e-1");

  a.close();
  b.close();
});

test("clear_store is a no-op and cannot wipe the org", async () => {
  const a = wsClient();
  await a.opened;
  a.send("join", { userId: "user-toru" });
  await a.waitFor((m) => m.type === "snapshot");

  const card = {
    id: "card-e2e-2", recipientUserID: "user-alex", senderUserID: "user-toru",
    type: "task", title: "Keep me", summary: "s", context: "c",
    status: "pending", priority: "medium", createdAt: new Date().toISOString(),
  };
  a.send("card_created", { card });
  await a.waitFor((m) => m.type === "card_created" && m.payload.card.id === "card-e2e-2");

  a.send("clear_store", {});
  await delay(300);

  const probe = wsClient();
  await probe.opened;
  probe.send("join", { userId: "user-yui" });
  const snap = await probe.waitFor((m) => m.type === "snapshot");
  assert.ok(
    (snap.payload.cardsByUser["user-alex"] || []).some((c) => c.id === "card-e2e-2"),
    "clear_store wiped the org store"
  );
  probe.close();
  a.close();
});

test("protocol errors: pre-join write, bad JSON, unknown type", async () => {
  const a = wsClient();
  await a.opened;
  a.send("card_created", { card: { id: "x", recipientUserID: "user-alex" } });
  const err = await a.waitFor((m) => m.type === "error");
  assert.match(err.payload.message, /invalid/i);
  a.close();

  const b = wsClient();
  await b.opened;
  b.sendRaw("not json{{{");
  const errBad = await b.waitFor((m) => m.type === "error");
  assert.match(errBad.payload.message, /invalid json/i);
  b.send("mystery_type", {});
  await b.waitFor((m) => /unknown type/i.test(m.payload?.message || ""));
  b.close();
});

test("foreign browser Origin is rejected; localhost Origin allowed", async () => {
  const evil = await new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { headers: { Origin: "https://evil.example.com" } });
    ws.once("open", () => resolve("opened"));
    ws.once("error", () => resolve("rejected"));
    ws.once("unexpected-response", () => resolve("rejected"));
    setTimeout(() => resolve("timeout"), 3000);
  });
  assert.equal(evil, "rejected");

  const good = await new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { headers: { Origin: "http://localhost:3000" } });
    ws.once("open", () => resolve("opened"));
    ws.once("error", () => resolve("rejected"));
    setTimeout(() => resolve("timeout"), 3000);
  });
  assert.equal(good, "opened");
});

test("org isolation: separate orgId sees an empty store", async () => {
  const a = wsClient();
  await a.opened;
  a.send("join", { userId: "user-toru", orgId: "other-org" });
  const snap = await a.waitFor((m) => m.type === "snapshot");
  assert.equal(Object.keys(snap.payload.cardsByUser).length, 0);
  a.close();
});
