import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.js");
const TOKEN = "test-relay-token";

function startServer(port, storePath) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_TOKEN: TOKEN,
      CARDS_STORE_PATH: storePath,
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      OPENROUTER_API_KEY: "",
    },
    stdio: "ignore",
  });
  return child;
}

async function waitForHealth(base, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return response.json();
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Relay did not come up in time");
}

function wsOpen(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timed out")), timeoutMs);
    const ws = new WebSocket(url);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message in time")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
    ws.once("close", () => reject(new Error("closed before message")));
    ws.once("error", reject);
  });
}

function collectMessages(ws, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(
      () => reject(new Error(`Only got ${collected.length}/${count} messages`)),
      timeoutMs
    );
    const onMessage = (raw) => {
      collected.push(JSON.parse(String(raw)));
      if (collected.length === count) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(collected);
      }
    };
    ws.on("message", onMessage);
  });
}

test("relay auth, refine endpoint, and persistence", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const storePath = join(mkdtempSync(join(tmpdir(), "relay-int-")), "cards.json");
  const child = startServer(port, storePath);
  t.after(() => child.kill("SIGKILL"));

  const health = await waitForHealth(base);
  assert.equal(health.authRequired, true);

  await t.test("HTTP requires bearer token", async () => {
    const denied = await fetch(`${base}/ai/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card: { title: "t", summary: "s" }, instruction: "x" }),
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/ai/refine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        card: { title: "Auth latency", summary: "p95 up", context: "", priority: "medium", cardType: "task" },
        instruction: "make this urgent",
      }),
    });
    assert.equal(allowed.status, 200);
    const refined = await allowed.json();
    assert.equal(refined.priority, "urgent");
  });

  await t.test("route endpoint honors token", async () => {
    const response = await fetch(`${base}/ai/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        text: "Ask Bob to fix the login bug",
        sender: { id: "user-alice", name: "Alice", role: "Product Manager" },
      }),
    });
    assert.equal(response.status, 200);
    const routing = await response.json();
    assert.equal(routing.recipientUserID, "user-bob");
  });

  await t.test("WS join without token is rejected", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: "join", payload: { userId: "user-alice" } }));
    const message = await nextMessage(ws);
    assert.equal(message.type, "error");
    ws.close();
  });

  await t.test("WS join with token gets snapshot and cards persist", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-alice", token: TOKEN } })
    );
    const [snapshot, channelSnapshot] = await collectMessages(ws, 2);
    assert.equal(snapshot.type, "snapshot");
    assert.equal(channelSnapshot.type, "channel_snapshot");

    ws.send(
      JSON.stringify({
        type: "card_created",
        payload: { card: { id: "card-p1", recipientUserID: "user-bob", title: "Persisted" } },
      })
    );
    const created = await nextMessage(ws);
    assert.equal(created.type, "card_created");
    ws.close();

    // debounced persist fires after ~500ms
    await new Promise((resolve) => setTimeout(resolve, 900));
    const written = JSON.parse(readFileSync(storePath, "utf8"));
    assert.equal(written["core-team"]["user-bob"][0].id, "card-p1");
  });

  await t.test("channels: snapshot on join, chat, @ai files a decision card", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-alice", token: TOKEN } })
    );
    const [, channelSnapshot] = await collectMessages(ws, 2);
    assert.equal(channelSnapshot.type, "channel_snapshot");
    const channelIDs = Object.keys(channelSnapshot.payload.channels);
    assert.ok(channelIDs.includes("channel-general"));

    ws.send(
      JSON.stringify({
        type: "channel_message",
        payload: {
          channelID: "channel-general",
          text: "@ai file: Bob to fix the login bug by Friday",
        },
      })
    );

    // human echo → card_created (agent filed it) → agent reply
    const events = await collectMessages(ws, 3);
    assert.equal(events[0].type, "channel_message");
    assert.equal(events[0].payload.message.authorName, "Alice");

    const cardEvent = events.find((event) => event.type === "card_created");
    assert.ok(cardEvent, "agent should file a decision card");
    assert.equal(cardEvent.payload.card.recipientUserID, "user-bob");
    assert.equal(cardEvent.payload.card.senderUserID, "user-alice");

    const agentEvent = events.find(
      (event) =>
        event.type === "channel_message" && event.payload.message.authorKind === "agent"
    );
    assert.ok(agentEvent, "agent should reply in channel");
    assert.equal(agentEvent.payload.message.cardID, cardEvent.payload.card.id);
    ws.close();
  });

  await t.test("ingest: updates flow to a channel, decisions return routing", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-carol", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };
    const sender = { id: "user-alice", name: "Alice", role: "Product Manager" };

    // Attach the listener BEFORE the POST: the relay broadcasts the WS
    // message before the HTTP response completes.
    const filedPromise = nextMessage(ws);
    filedPromise.catch(() => {});

    const updateResponse = await fetch(`${base}/ai/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "Made progress on the relay migration today",
        sender,
      }),
    });
    assert.equal(updateResponse.status, 200);
    const update = await updateResponse.json();
    assert.equal(update.kind, "update");
    assert.equal(update.channel.name, "general");

    const filed = await filedPromise;
    assert.equal(filed.type, "channel_message");
    assert.equal(filed.payload.message.authorName, "Alice");
    assert.equal(filed.payload.message.channelID, update.channel.id);

    const decisionResponse = await fetch(`${base}/ai/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "Ask Bob to review the relay PR before Friday",
        sender,
      }),
    });
    assert.equal(decisionResponse.status, 200);
    const decision = await decisionResponse.json();
    assert.equal(decision.kind, "decision");
    assert.equal(decision.routing.recipientUserID, "user-bob");
    assert.ok(decision.channel.id);
    ws.close();
  });

  await t.test("card_created with channelID leaves an agent log in the channel", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-alice", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    ws.send(
      JSON.stringify({
        type: "card_created",
        payload: {
          card: {
            id: "card-log1",
            recipientUserID: "user-bob",
            senderUserID: "user-alice",
            title: "Review relay PR",
            channelID: "channel-general",
          },
        },
      })
    );

    const events = await collectMessages(ws, 2);
    assert.equal(events[0].type, "card_created");
    assert.equal(events[1].type, "channel_message");
    assert.equal(events[1].payload.message.authorKind, "agent");
    assert.equal(events[1].payload.message.authorName, "Alice's AI");
    assert.equal(events[1].payload.message.cardID, "card-log1");
    ws.close();
  });

  await t.test("channel_create broadcasts a normalized channel", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    ws.send(
      JSON.stringify({ type: "channel_create", payload: { name: "Launch Plan" } })
    );
    const created = await nextMessage(ws);
    assert.equal(created.type, "channel_created");
    assert.equal(created.payload.channel.name, "launch-plan");
    ws.close();
  });
});
