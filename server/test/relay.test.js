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

// Every store lives beside the card store, in the test's own temp directory.
// Sharing the repo's server/data would make these tests read each other's
// state — and the autopilot test asserts on what memory.json does *not*
// contain.
function storePathsFrom(storePath) {
  const dir = dirname(storePath);
  return {
    CARDS_STORE_PATH: storePath,
    CHANNELS_STORE_PATH: join(dir, "channels.json"),
    ORG_STORE_PATH: join(dir, "org.json"),
    PUSH_STORE_PATH: join(dir, "push.json"),
    DIGEST_STORE_PATH: join(dir, "digest.json"),
    MEMORY_STORE_PATH: join(dir, "memory.json"),
    SESSIONS_STORE_PATH: join(dir, "sessions.json"),
  };
}

function startServer(port, storePath) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_TOKEN: TOKEN,
      ...storePathsFrom(storePath),
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      GITHUB_WEBHOOK_SECRET: HOOK_SECRET,
      OPENROUTER_API_KEY: "",
      // The sweeps are driven explicitly by the tests that need them.
      AUTOPILOT_INTERVAL_MINUTES: "0",
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

    // one-tap provenance: the filed card links back to the conversation
    const sources = cardEvent.payload.card.sources;
    assert.ok(sources && sources[0].kind === "channel");
    assert.equal(sources[0].channelID, "channel-general");
    assert.ok(sources[0].messageID, "source should point at the triggering message");
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

  await t.test("decide: resolves server-side and notifies the sender", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    };

    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } }));
    await collectMessages(ws, 2);

    // Alice asks Bob for something.
    ws.send(
      JSON.stringify({
        type: "card_created",
        payload: {
          card: {
            id: "card-decide-1",
            recipientUserID: "user-bob",
            senderUserID: "user-alice",
            type: "approval",
            title: "Approve the launch plan",
            summary: "Launch plan needs sign-off.",
            context: "deadline: Friday",
            status: "pending",
            priority: "high",
            createdAt: new Date().toISOString(),
          },
        },
      })
    );
    await collectUntil(ws, (messages) =>
      messages.some((m) => m.type === "card_created" && m.payload.card.id === "card-decide-1")
    );

    const eventsPromise = collectUntil(
      ws,
      (messages) =>
        messages.some(
          (m) => m.type === "card_updated" && m.payload.card.id === "card-decide-1"
        ) &&
        messages.some(
          (m) => m.type === "card_created" && m.payload.card.recipientUserID === "user-alice"
        )
    );
    eventsPromise.catch(() => {});

    // Bob approves with a condition — no GitHub credentials in this test, so
    // the decision must still land (the sync is best-effort).
    const response = await fetch(`${base}/cards/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        actorUserID: "user-bob",
        cardId: "card-decide-1",
        action: "approve",
        note: "release after Friday",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.card.status, "approved");
    assert.ok(result.card.context.includes("Condition: release after Friday"));

    const events = await eventsPromise;
    const notice = events.find(
      (m) => m.type === "card_created" && m.payload.card.recipientUserID === "user-alice"
    ).payload.card;
    assert.ok(notice.summary.includes("Bob"));

    // Deciding twice is a conflict, not a duplicate decision.
    const again = await fetch(`${base}/cards/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ actorUserID: "user-bob", cardId: "card-decide-1", action: "reject" }),
    });
    assert.equal(again.status, 409);

    // Another user can't decide Bob's card.
    const wrongUser = await fetch(`${base}/cards/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ actorUserID: "user-carol", cardId: "card-decide-1", action: "approve" }),
    });
    assert.equal(wrongUser.status, 404);

    // And the endpoint is behind the auth gate.
    const unauthorized = await fetch(`${base}/cards/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserID: "user-bob", cardId: "x", action: "approve" }),
    });
    assert.equal(unauthorized.status, 401);

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

  await t.test("decide: the shape iOS sends works for every action", async () => {
    // iOS authenticates with the relay token and names the actor in the body
    // (no session cookie), unlike the web client. Every action it can send
    // has to work through that door.
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } }));
    await collectMessages(ws, 2);

    const seed = async (id, overrides = {}) => {
      const landed = collectUntil(ws, (messages) =>
        messages.some((m) => m.type === "card_created" && m.payload.card.id === id)
      );
      ws.send(
        JSON.stringify({
          type: "card_created",
          payload: {
            card: {
              id,
              recipientUserID: "user-bob",
              senderUserID: "user-alice",
              type: "approval",
              title: "Approve the rollout",
              summary: "Staged rollout to 10%",
              context: "",
              status: "pending",
              priority: "medium",
              createdAt: new Date().toISOString(),
              ...overrides,
            },
          },
        })
      );
      await landed;
    };

    const decide = (body) =>
      fetch(`${base}/cards/decide`, {
        method: "POST",
        headers,
        body: JSON.stringify({ actorUserID: "user-bob", ...body }),
      });

    await seed("card-ios-revise");
    const revised = await decide({
      cardId: "card-ios-revise",
      action: "revise",
      note: "split this in two",
    });
    assert.equal(revised.status, 200);
    const revisedCard = (await revised.json()).card;
    assert.equal(revisedCard.status, "revised");
    assert.ok(revisedCard.context.includes("Revision: split this in two"));

    await seed("card-ios-ack", { type: "notification" });
    const acked = await decide({ cardId: "card-ios-ack", action: "acknowledge" });
    assert.equal(acked.status, 200);
    assert.equal((await acked.json()).card.status, "acknowledged");

    await seed("card-ios-delegate");
    const delegated = await decide({
      cardId: "card-ios-delegate",
      action: "delegate",
      delegateToUserID: "user-carol",
    });
    assert.equal(delegated.status, 200);
    assert.equal((await delegated.json()).card.status, "delegated");

    await seed("card-ios-priority");
    const prioritized = await decide({
      cardId: "card-ios-priority",
      action: "priority",
      priority: "urgent",
    });
    assert.equal(prioritized.status, 200);
    assert.equal((await prioritized.json()).card.priority, "urgent");

    // Delegating to a non-member is rejected rather than silently dropped.
    await seed("card-ios-bad-delegate");
    const bad = await decide({
      cardId: "card-ios-bad-delegate",
      action: "delegate",
      delegateToUserID: "user-nobody",
    });
    assert.equal(bad.status, 400);

    ws.close();
  });

  await t.test("ledger: decisions made earlier in this suite are now history", async () => {
    const headers = { Authorization: `Bearer ${TOKEN}` };

    const all = await (await fetch(`${base}/ledger`, { headers })).json();
    assert.ok(all.entries.length > 0, "the suite has decided cards by now");

    const decided = all.entries.find((entry) => entry.decidedAt);
    assert.ok(decided, "at least one entry carries when it was decided");
    assert.equal(typeof decided.leadTimeMinutes, "number");
    assert.ok(decided.decidedByUserID, "the ledger records who decided");

    // A pending card has no lead time — zero would claim it was instant.
    const pendingOnly = await (
      await fetch(`${base}/ledger?status=pending`, { headers })
    ).json();
    for (const entry of pendingOnly.entries) {
      assert.equal(entry.leadTimeMinutes, null);
      assert.equal(entry.decidedAt, null);
    }

    // Scoping to a person still covers what they sent, and drops the org-wide
    // bottleneck view, which would mean nothing filtered to one queue.
    const bobs = await (
      await fetch(`${base}/ledger?userId=user-bob`, { headers })
    ).json();
    assert.ok(bobs.entries.length > 0);
    assert.ok(
      bobs.entries.every(
        (entry) =>
          entry.recipientUserID === "user-bob" ||
          entry.senderUserID === "user-bob" ||
          entry.decidedByUserID === "user-bob"
      )
    );
    assert.deepEqual(bobs.bottlenecks, []);

    const search = await (
      await fetch(`${base}/ledger?q=vendor+contract`, { headers })
    ).json();
    assert.ok(
      search.entries.every((entry) =>
        `${entry.title} ${entry.summary}`.toLowerCase().includes("vendor")
      )
    );

    assert.equal((await fetch(`${base}/ledger?userId=nobody`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/ledger`)).status, 401);
  });

  await t.test("autopilot: opt-in, held, marked, and not self-taught", async () => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } }));
    await collectMessages(ws, 2);

    const seed = async (id, overrides = {}) => {
      const landed = collectUntil(ws, (messages) =>
        messages.some((m) => m.type === "card_created" && m.payload.card.id === id)
      );
      ws.send(
        JSON.stringify({
          type: "card_created",
          payload: {
            card: {
              id,
              recipientUserID: "user-bob",
              senderUserID: "user-alice",
              type: "approval",
              title: "Approve the staging rollout",
              summary: "10% traffic",
              context: "",
              status: "pending",
              priority: "medium",
              // Old enough to be past any hold window.
              createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
              recommendation: { action: "approve", reason: "You approved the last 4" },
              ...overrides,
            },
          },
        })
      );
      await landed;
    };

    await seed("card-autopilot-1");

    // Nobody has opted in yet, so a sweep does nothing at all.
    const idle = await fetch(`${base}/autopilot/run`, { method: "POST", headers });
    assert.equal(idle.status, 200);
    assert.equal((await idle.json()).decided, 0);

    // Opting in is a per-person choice, and the relay echoes what will
    // actually happen rather than what was asked for.
    const opted = await fetch(`${base}/org/autopilot`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: "user-bob",
        autopilot: { enabled: true, holdMinutes: 60, maxPriority: "urgent" },
      }),
    });
    assert.equal(opted.status, 200);
    assert.equal((await opted.json()).autopilot.maxPriority, "high");

    const decidedEvents = collectUntil(ws, (messages) =>
      messages.some(
        (m) => m.type === "card_updated" && m.payload.card.id === "card-autopilot-1"
      )
    );

    const run = await fetch(`${base}/autopilot/run`, { method: "POST", headers });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).decided, 1);

    const messages = await decidedEvents;
    const decided = messages
      .filter((m) => m.type === "card_updated" && m.payload.card.id === "card-autopilot-1")
      .pop().payload.card;

    assert.equal(decided.status, "approved");
    assert.equal(decided.decidedByAI, true);
    assert.ok(decided.autopilotAt, "the card records when autopilot acted");
    assert.ok(
      decided.context.includes("Approved by your AI"),
      "the card says a machine decided it"
    );

    // Running again is a no-op: it never reconsiders its own work.
    const again = await fetch(`${base}/autopilot/run`, { method: "POST", headers });
    assert.equal((await again.json()).decided, 0);

    // The decision must NOT enter Bob's memory — a system that learns from its
    // own predictions only ever confirms itself. A card that arrives later
    // still has to earn its recommendation from human decisions alone.
    const memory = await (
      await fetch(`${base}/memory?userId=user-bob`, { headers })
    ).json();
    assert.ok(
      memory.entries.length > 0,
      "Bob's human decisions earlier in this suite should be recorded"
    );
    assert.ok(
      !memory.entries.some((entry) => entry.title?.includes("staging rollout")),
      "an autopilot decision was written to decision memory"
    );

    // Turning it back off holds for the next sweep.
    await fetch(`${base}/org/autopilot`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "user-bob", autopilot: { enabled: false } }),
    });
    await seed("card-autopilot-2");
    const off = await fetch(`${base}/autopilot/run`, { method: "POST", headers });
    assert.equal((await off.json()).decided, 0);

    ws.close();
  });

  await t.test("notion: gated by auth, and off means off — not broken", async () => {
    // Behind the auth gate like every other API route.
    const denied = await fetch(`${base}/sources/notion?url=https://notion.so/x`);
    assert.equal(denied.status, 401);

    // This relay has no NOTION_TOKEN. The endpoint says so plainly instead of
    // failing in a way a client would have to guess at.
    const off = await fetch(`${base}/sources/notion?url=https://notion.so/x`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(off.status, 503);

    // And the health check reports it, so a client knows before it asks.
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.notion, false);
  });

  await t.test("notion off: cards still carry their link provenance", async () => {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: "join", payload: { userId: "user-bob", token: TOKEN } }));
    await collectMessages(ws, 2);

    const created = collectUntil(ws, (messages) =>
      messages.some(
        (message) =>
          message.type === "card_created" && message.payload.card.id === "card-notion-off"
      )
    );

    ws.send(
      JSON.stringify({
        type: "card_created",
        payload: {
          card: {
            id: "card-notion-off",
            recipientUserID: "user-bob",
            senderUserID: "user-alice",
            type: "approval",
            title: "Approve the onboarding rewrite",
            summary: "Spec: https://www.notion.so/team/Onboarding-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
            context: "",
            status: "pending",
            priority: "high",
            createdAt: new Date().toISOString(),
          },
        },
      })
    );

    const messages = await created;
    const card = messages.find((m) => m.payload?.card?.id === "card-notion-off").payload.card;
    const notionSource = card.sources.find((source) => source.url?.includes("notion.so"));

    // Unresolved, so it stays the generic chip — but it is still there.
    assert.equal(notionSource.kind, "link");
    assert.equal(notionSource.label, "Notion");

    ws.close();
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
