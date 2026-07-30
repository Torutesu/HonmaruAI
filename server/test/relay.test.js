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

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
    ws.once("close", () => reject(new Error("closed before message")));
    ws.once("error", reject);
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
    const snapshot = await nextMessage(ws);
    assert.equal(snapshot.type, "snapshot");

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
});
