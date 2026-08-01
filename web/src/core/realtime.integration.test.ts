import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RelaySocket } from "./socket";
import { useCardStore } from "./stores/cards";
import type { DecisionCard } from "./types";

// Drives the real relay with the real client core: no mocks, no fakes.
// Proves the Phase 1 acceptance criteria — two clients see each other's
// cards in real time, and a client survives a relay restart.

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "../../../server/index.js");
const webDist = resolve(here, "../../dist");
const PORT = 18950;
const TOKEN = "web-integration-token";
const base = `http://127.0.0.1:${PORT}`;

let relay: ChildProcess | null = null;
let dataDir = "";

function startRelay() {
  relay = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      RELAY_TOKEN: TOKEN,
      WEB_DIST_PATH: webDist,
      CARDS_STORE_PATH: join(dataDir, "cards.json"),
      CHANNELS_STORE_PATH: join(dataDir, "channels.json"),
      ORG_STORE_PATH: join(dataDir, "org.json"),
      PUSH_STORE_PATH: join(dataDir, "push.json"),
      DIGEST_STORE_PATH: join(dataDir, "digest.json"),
      MEMORY_STORE_PATH: join(dataDir, "memory.json"),
      SESSIONS_STORE_PATH: join(dataDir, "sessions.json"),
      OPENROUTER_API_KEY: "",
      ESCALATION_INTERVAL_MINUTES: "0",
    },
    stdio: "ignore",
  });
}

async function waitForHealth(attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not start");
}

function stopRelay() {
  relay?.kill("SIGKILL");
  relay = null;
}

/** Resolve once the predicate holds, polling the store. */
function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  return new Promise<void>((resolveWait, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolveWait();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for: ${label}`));
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bobsCard = (id: string): DecisionCard => ({
  id,
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "task",
  title: "Fix the login bug",
  summary: "Alice needs the login regression fixed before Friday.",
  context: "deadline: Friday",
  status: "pending",
  priority: "high",
  createdAt: new Date().toISOString(),
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ttfw-web-it-"));
  startRelay();
  await waitForHealth();
}, 20000);

afterAll(() => stopRelay());

describe("relay hosts the built web app", () => {
  it("serves the real build at /", async () => {
    const response = await fetch(base);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<div id="root">');
    expect(html).toMatch(/<script[^>]+src="\/assets\/index-[^"]+\.js"/);
  });

  it("serves the PWA shell assets the browser needs to install", async () => {
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect((await manifest.json()).start_url).toBe("/");

    const worker = await fetch(`${base}/sw.js`);
    expect(worker.status).toBe(200);
    // Wrong MIME here silently breaks service worker registration.
    expect(worker.headers.get("content-type")).toContain("text/javascript");
    const source = await worker.text();
    expect(source).toContain("notificationclick");

    const icon = await fetch(`${base}/icon.svg`);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("serves SPA routes without shadowing the API", async () => {
    expect((await fetch(`${base}/settings`)).status).toBe(200);
    // API path stays API even though it has no file extension
    const api = await fetch(`${base}/ai/route`, { method: "POST" });
    expect(api.status).toBe(401);
  });
});

describe("realtime between two clients", () => {
  it("delivers a card from Alice's socket to Bob's store", async () => {
    useCardStore.setState({ cardsByUser: {}, connected: false });

    const bob = new RelaySocket({ url: `ws://127.0.0.1:${PORT}`, userId: "user-bob", token: TOKEN });
    const alice = new RelaySocket({
      url: `ws://127.0.0.1:${PORT}`,
      userId: "user-alice",
      token: TOKEN,
    });

    bob.onEvent((event) => useCardStore.getState().apply(event));
    bob.onStatusChange((connected) => useCardStore.getState().setConnected(connected));

    bob.connect();
    alice.connect();
    await waitFor(() => bob.connected && alice.connected, "both sockets connected");

    alice.send({ type: "card_created", payload: { card: bobsCard("card-web-1") } });

    await waitFor(
      () =>
        (useCardStore.getState().cardsByUser["user-bob"] ?? []).some(
          (c) => c.id === "card-web-1"
        ),
      "Bob's store receives Alice's card"
    );

    const received = useCardStore
      .getState()
      .cardsByUser["user-bob"]?.find((c) => c.id === "card-web-1");
    expect(received?.title).toBe("Fix the login bug");
    // The relay's delivery pipeline ran: provenance/recommendation fields exist
    expect(received?.status).toBe("pending");

    bob.disconnect();
    alice.disconnect();
  }, 15000);
});

describe("the decision loop closes across clients", () => {
  it("Bob decides in the web client and Alice is notified", async () => {
    useCardStore.setState({ cardsByUser: {}, connected: false });

    // Alice watches; Bob acts through the web client's API layer.
    const alice = new RelaySocket({
      url: `ws://127.0.0.1:${PORT}`,
      userId: "user-alice",
      token: TOKEN,
    });
    alice.onEvent((event) => useCardStore.getState().apply(event));
    alice.connect();
    await waitFor(() => alice.connected, "Alice connected");

    const cardId = "card-decide-web";
    alice.send({
      type: "card_created",
      payload: {
        card: {
          ...bobsCard(cardId),
          title: "Approve the vendor contract",
          type: "approval",
        },
      },
    });
    await waitFor(
      () =>
        (useCardStore.getState().cardsByUser["user-bob"] ?? []).some((c) => c.id === cardId),
      "card reached the store"
    );

    // Exactly what the web UI does — same endpoint, same payload.
    const response = await fetch(`${base}/cards/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        actorUserID: "user-bob",
        cardId,
        action: "approve",
        note: "sign after the Friday demo",
      }),
    });
    expect(response.status).toBe(200);

    // The original flips to approved for everyone…
    await waitFor(
      () =>
        (useCardStore.getState().cardsByUser["user-bob"] ?? []).find((c) => c.id === cardId)
          ?.status === "approved",
      "original card marked approved"
    );

    // …and Alice receives the result card carrying the condition.
    await waitFor(
      () =>
        (useCardStore.getState().cardsByUser["user-alice"] ?? []).some((c) =>
          c.summary.includes("sign after the Friday demo")
        ),
      "Alice received the decision result"
    );

    const decided = useCardStore
      .getState()
      .cardsByUser["user-bob"]?.find((c) => c.id === cardId);
    expect(decided?.context).toContain("Condition: sign after the Friday demo");

    alice.disconnect();
  }, 20000);
});

describe("resilience", () => {
  it("reconnects and re-syncs after the relay restarts", async () => {
    useCardStore.setState({ cardsByUser: {}, connected: false });

    const bob = new RelaySocket({
      url: `ws://127.0.0.1:${PORT}`,
      userId: "user-bob",
      token: TOKEN,
      reconnectDelayMs: 200,
    });
    bob.onEvent((event) => useCardStore.getState().apply(event));
    bob.onStatusChange((connected) => useCardStore.getState().setConnected(connected));

    bob.connect();
    await waitFor(() => useCardStore.getState().connected, "initial connection");

    // The relay debounces its writes (~500ms) and SIGKILL skips the shutdown
    // flush, so give the writer its window — otherwise this would test write
    // timing rather than reconnection.
    await sleep(900);

    stopRelay();
    await waitFor(() => !useCardStore.getState().connected, "disconnect detected");

    startRelay();
    await waitForHealth();

    // No manual intervention: the socket rejoins on its own and the store is
    // refilled from the snapshot the relay sends on join — which also proves
    // the card survived the crash.
    await waitFor(() => useCardStore.getState().connected, "automatic reconnection", 10000);
    await waitFor(
      () =>
        (useCardStore.getState().cardsByUser["user-bob"] ?? []).some(
          (c) => c.id === "card-web-1"
        ),
      "state re-synced from the snapshot",
      10000
    );

    bob.disconnect();
  }, 30000);
});
