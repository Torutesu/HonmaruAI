import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.js");
const TOKEN = "test-relay-token";
const HOOK_SECRET = "test-hook-secret";

function startServer(port, storePath) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_TOKEN: TOKEN,
      CARDS_STORE_PATH: storePath,
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      GITHUB_WEBHOOK_SECRET: HOOK_SECRET,
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

// Collect messages until the predicate is satisfied. Tolerates unrelated
// events (e.g. presence broadcasts from other sockets closing).
function collectUntil(ws, isDone, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `collectUntil timed out after ${collected.length} messages: ${collected
              .map((message) => message.type)
              .join(", ")}`
          )
        ),
      timeoutMs
    );
    const onMessage = (raw) => {
      collected.push(JSON.parse(String(raw)));
      if (isDone(collected)) {
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

    const eventsPromise = collectUntil(
      ws,
      (messages) =>
        messages.some((message) => message.type === "card_created") &&
        messages.filter((message) => message.type === "channel_message").length >= 2
    );
    eventsPromise.catch(() => {});

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
    const events = await eventsPromise;
    const humanEvent = events.find((event) => event.type === "channel_message");
    assert.equal(humanEvent.payload.message.authorName, "Alice");

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
    const filedPromise = collectUntil(ws, (messages) =>
      messages.some((message) => message.type === "channel_message")
    );
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

    const filed = (await filedPromise).find(
      (message) => message.type === "channel_message"
    );
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

    const eventsPromise = collectUntil(
      ws,
      (messages) =>
        messages.some((message) => message.type === "card_created") &&
        messages.some((message) => message.type === "channel_message")
    );
    eventsPromise.catch(() => {});

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

    const events = await eventsPromise;
    const logEvent = events.find((event) => event.type === "channel_message");
    assert.equal(logEvent.payload.message.authorKind, "agent");
    assert.equal(logEvent.payload.message.authorName, "Alice's AI");
    assert.equal(logEvent.payload.message.cardID, "card-log1");
    ws.close();
  });

  await t.test("digest: run produces one quiet card per user with unseen activity", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };

    // Bob is connected and should receive Alice's digest-worthy activity
    // as a card_created broadcast when the digest runs.
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    const digestCardPromise = collectUntil(ws, (messages) =>
      messages.some(
        (message) =>
          message.type === "card_created" &&
          message.payload.card.title === "Team digest" &&
          message.payload.card.recipientUserID === "user-bob"
      )
    );
    digestCardPromise.catch(() => {});

    const run = await fetch(`${base}/digest/run`, { method: "POST", headers });
    assert.equal(run.status, 200);
    const result = await run.json();
    assert.ok(result.digests >= 1, "at least one digest for earlier channel chatter");

    const events = await digestCardPromise;
    const digestCard = events.find(
      (message) =>
        message.type === "card_created" &&
        message.payload.card.title === "Team digest" &&
        message.payload.card.recipientUserID === "user-bob"
    ).payload.card;
    assert.equal(digestCard.priority, "low");
    assert.equal(digestCard.type, "notification");

    // Immediately re-running finds nothing new.
    const second = await fetch(`${base}/digest/run`, { method: "POST", headers });
    const secondResult = await second.json();
    assert.equal(secondResult.digests, 0);
    ws.close();
  });

  await t.test("memory: three approvals teach the AI to recommend the fourth", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-dana", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    // Dana approves three similar requests from Carol.
    for (let i = 1; i <= 3; i += 1) {
      const id = `card-mem-${i}`;
      const cardBase = {
        id,
        recipientUserID: "user-dana",
        senderUserID: "user-carol",
        type: "approval",
        title: `Approve design spend ${i}`,
        summary: "Budget approval.",
        priority: "medium",
        createdAt: new Date().toISOString(),
      };
      ws.send(JSON.stringify({ type: "card_created", payload: { card: { ...cardBase, status: "pending" } } }));
      await collectUntil(ws, (messages) =>
        messages.some((m) => m.type === "card_created" && m.payload.card.id === id)
      );
      ws.send(JSON.stringify({ type: "card_updated", payload: { card: { ...cardBase, status: "approved" } } }));
      await collectUntil(ws, (messages) =>
        messages.some((m) => m.type === "card_updated" && m.payload.card.id === id)
      );
    }

    // The fourth similar card arrives with a one-tap recommendation.
    const recPromise = collectUntil(ws, (messages) =>
      messages.some(
        (m) => m.type === "card_created" && m.payload.card.id === "card-mem-4"
      )
    );
    recPromise.catch(() => {});
    ws.send(
      JSON.stringify({
        type: "card_created",
        payload: {
          card: {
            id: "card-mem-4",
            recipientUserID: "user-dana",
            senderUserID: "user-carol",
            type: "approval",
            title: "Approve design spend 4",
            summary: "Budget approval.",
            status: "pending",
            priority: "medium",
            createdAt: new Date().toISOString(),
          },
        },
      })
    );

    const events = await recPromise;
    const card = events.find(
      (m) => m.type === "card_created" && m.payload.card.id === "card-mem-4"
    ).payload.card;
    assert.ok(card.recommendation, "expected a recommendation on the fourth card");
    assert.equal(card.recommendation.action, "approve");
    assert.ok(card.recommendation.reason.length > 0);
    ws.close();
  });

  await t.test("escalation: an overdue card climbs to the manager", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };

    // Alice manages Bob. Plant a 10h-old high card in Bob's feed, then sweep.
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-alice", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    const staleCreated = new Date(Date.now() - 10 * 3600000).toISOString();
    ws.send(
      JSON.stringify({
        type: "card_created",
        payload: {
          card: {
            id: "card-stale-1",
            recipientUserID: "user-bob",
            senderUserID: "user-carol",
            type: "approval",
            title: "Approve vendor contract",
            summary: "Contract needs sign-off.",
            status: "pending",
            priority: "high",
            createdAt: staleCreated,
          },
        },
      })
    );
    await collectUntil(ws, (messages) =>
      messages.some(
        (message) =>
          message.type === "card_created" && message.payload.card.id === "card-stale-1"
      )
    );

    const escalationPromise = collectUntil(ws, (messages) =>
      messages.some(
        (message) =>
          message.type === "card_created" &&
          message.payload.card.recipientUserID === "user-alice" &&
          String(message.payload.card.title).startsWith("Escalated:")
      ) &&
      messages.some(
        (message) =>
          message.type === "card_updated" && message.payload.card.id === "card-stale-1"
      )
    );
    escalationPromise.catch(() => {});

    const run = await fetch(`${base}/escalations/run`, { method: "POST", headers });
    assert.equal(run.status, 200);
    const result = await run.json();
    assert.ok(result.escalated >= 1);

    const events = await escalationPromise;
    const escalation = events.find(
      (message) =>
        message.type === "card_created" &&
        String(message.payload.card.title).startsWith("Escalated:")
    ).payload.card;
    assert.equal(escalation.recipientUserID, "user-alice");
    assert.equal(escalation.priority, "high");
    assert.ok(escalation.routingReason.includes("you manage Bob"));

    const updated = events.find(
      (message) =>
        message.type === "card_updated" && message.payload.card.id === "card-stale-1"
    ).payload.card;
    assert.ok(updated.escalatedAt);
    assert.ok(updated.context.includes("escalated:"));

    // Second sweep: already marked, nothing new.
    const second = await fetch(`${base}/escalations/run`, { method: "POST", headers });
    assert.equal((await second.json()).escalated, 0);
    ws.close();
  });

  await t.test("github webhook: signed review request lands as a card", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    const cardPromise = collectUntil(ws, (messages) =>
      messages.some(
        (message) =>
          message.type === "card_created" &&
          message.payload.card.recipientUserID === "user-bob" &&
          String(message.payload.card.title).includes("PR #12")
      )
    );
    cardPromise.catch(() => {});

    const body = JSON.stringify({
      action: "review_requested",
      repository: { full_name: "torutesu/honmaruai" },
      sender: { login: "alice" },
      requested_reviewer: { login: "bob" },
      pull_request: {
        number: 12,
        title: "Relay deploy config",
        html_url: "https://github.com/torutesu/honmaruai/pull/12",
        head: { ref: "deploy" },
      },
    });
    const signature =
      "sha256=" + createHmac("sha256", HOOK_SECRET).update(body).digest("hex");

    // Note: no relay bearer token — webhooks authenticate via HMAC only.
    const response = await fetch(`${base}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": signature,
      },
      body,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.cards, 1);

    const events = await cardPromise;
    const card = events.find((message) => message.type === "card_created").payload.card;
    assert.equal(card.priority, "high");
    assert.equal(card.senderUserID, "user-alice");

    const badSignature = await fetch(`${base}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": "sha256=" + "0".repeat(64),
      },
      body,
    });
    assert.equal(badSignature.status, 401);
    ws.close();
  });

  await t.test("org language endpoint updates and broadcasts", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };
    const response = await fetch(`${base}/org/language`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "user-alice", language: "日本語" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.user.language, "日本語");
  });

  await t.test("push: register endpoint requires auth and stores tokens", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };

    const denied = await fetch(`${base}/push/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-alice", deviceToken: "a".repeat(64) }),
    });
    assert.equal(denied.status, 401);

    const ok = await fetch(`${base}/push/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "user-alice", deviceToken: "a".repeat(64) }),
    });
    assert.equal(ok.status, 200);
    const registered = await ok.json();
    assert.equal(registered.registered, true);
    assert.equal(registered.pushEnabled, false);

    const bad = await fetch(`${base}/push/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "user-alice", deviceToken: "nope" }),
    });
    assert.equal(bad.status, 400);
  });

  await t.test("org: fetch, add member, routing follows", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };

    const orgResponse = await fetch(`${base}/org`, { headers });
    assert.equal(orgResponse.status, 200);
    const org = await orgResponse.json();
    assert.equal(org.users.length, 4);
    assert.ok(org.nodes.length > 0 && org.edges.length > 0);

    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-alice", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    const orgUpdatedPromise = collectUntil(ws, (messages) =>
      messages.some((message) => message.type === "org_updated")
    );
    orgUpdatedPromise.catch(() => {});

    const addResponse = await fetch(`${base}/org/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Erin",
        role: "Designer",
        team: "Design Team",
        githubUsername: "erin-gh",
      }),
    });
    assert.equal(addResponse.status, 200);
    const added = await addResponse.json();
    assert.equal(added.user.id, "user-erin");
    assert.equal(added.organization.users.length, 5);

    const orgUpdated = (await orgUpdatedPromise).find(
      (message) => message.type === "org_updated"
    );
    assert.equal(orgUpdated.payload.users.length, 5);

    const routeResponse = await fetch(`${base}/ai/route`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "Ask Erin to polish the onboarding mockups",
        sender: { id: "user-alice", name: "Alice", role: "Product Manager" },
      }),
    });
    assert.equal(routeResponse.status, 200);
    const routing = await routeResponse.json();
    assert.equal(routing.recipientUserID, "user-erin");
    ws.close();
  });

  await t.test("channel_create broadcasts a normalized channel", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(
      JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } })
    );
    await collectMessages(ws, 2);

    const createdPromise = collectUntil(ws, (messages) =>
      messages.some((message) => message.type === "channel_created")
    );
    createdPromise.catch(() => {});

    ws.send(
      JSON.stringify({ type: "channel_create", payload: { name: "Launch Plan" } })
    );
    const created = (await createdPromise).find(
      (message) => message.type === "channel_created"
    );
    assert.equal(created.payload.channel.name, "launch-plan");
    ws.close();
  });
});
