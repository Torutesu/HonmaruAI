import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import {
  routeInstruction,
  refineCard,
  interpretReply,
  userNameFor,
  setActiveOrg,
} from "./agentTools.js";
import { createOrgStore } from "./org.js";
import { createAPNS, createPushRegistry, shouldNotify } from "./push.js";
import { collectDigestSections, generateDigest, buildDigestCard } from "./digest.js";
import { translateCard } from "./translate.js";
import { verifyWebhookSignature, cardsFromWebhook } from "./githubWebhook.js";
import { parseSLAConfig, findOverdueCards, buildEscalationCard } from "./escalation.js";
import { loadPersistedStores, createPersister } from "./persistence.js";
import {
  createChannelStore,
  parseAgentMention,
  generateAgentReply,
  classifyInput,
} from "./channels.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, ".env"));

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const PORT = Number(process.env.PORT || 8080);
const ORG_ID = "core-team";

// Optional shared secret. When set, every HTTP endpoint except /health
// requires `Authorization: Bearer <token>` and WebSocket joins must carry
// the token in the join payload. Required for any non-localhost deploy.
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";

// HMAC secret for GitHub webhooks (X-Hub-Signature-256). Unset = accept all
// (dev only) — the endpoint itself is exempt from the bearer-token gate
// because GitHub cannot send it.
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

const STORE_PATH =
  process.env.CARDS_STORE_PATH || join(__dirname, "data", "cards.json");
const CHANNELS_STORE_PATH =
  process.env.CHANNELS_STORE_PATH || join(__dirname, "data", "channels.json");
const ORG_STORE_PATH =
  process.env.ORG_STORE_PATH || join(__dirname, "data", "org.json");
const PUSH_STORE_PATH =
  process.env.PUSH_STORE_PATH || join(__dirname, "data", "push.json");
const DIGEST_STORE_PATH =
  process.env.DIGEST_STORE_PATH || join(__dirname, "data", "digest.json");
// 0 disables the periodic digest; POST /digest/run always works.
const DIGEST_INTERVAL_MINUTES = Number(process.env.DIGEST_INTERVAL_MINUTES || 0);

// SLA table (override e.g. SLA_MINUTES="urgent:60,high:240") and how often
// to sweep for breaches. 0 disables the sweep; POST /escalations/run always works.
const SLA_MINUTES = parseSLAConfig(process.env.SLA_MINUTES);
const ESCALATION_INTERVAL_MINUTES = Number(process.env.ESCALATION_INTERVAL_MINUTES || 15);

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const GITHUB_REDIRECT_URI =
  process.env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback";
const GITHUB_OAUTH_SCOPE = process.env.GITHUB_OAUTH_SCOPE || "repo";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "TikTok for Work";
const OPENROUTER_APP_URL = process.env.OPENROUTER_APP_URL || "http://localhost:8080";

const initialCards = {};

/** @type {Map<string, Record<string, object[]>>} */
const orgStores =
  loadPersistedStores(STORE_PATH) || new Map([[ORG_ID, structuredClone(initialCards)]]);
const persister = createPersister(STORE_PATH);

const persistedOrg = loadPersistedStores(ORG_STORE_PATH);
const orgStore = createOrgStore(
  persistedOrg ? Object.fromEntries(persistedOrg.entries()) : null
);
setActiveOrg(orgStore);
const orgPersister = createPersister(ORG_STORE_PATH);

function persistOrg() {
  const serialized = orgStore.serialize();
  orgPersister.schedule(
    new Map([
      ["users", serialized.users],
      ["nodes", serialized.nodes],
      ["edges", serialized.edges],
    ])
  );
}

const apns = createAPNS(process.env);
const persistedPush = loadPersistedStores(PUSH_STORE_PATH);
const pushRegistry = createPushRegistry(
  persistedPush ? Object.fromEntries(persistedPush.entries()) : null
);
const pushPersister = createPersister(PUSH_STORE_PATH);

function persistPush() {
  pushPersister.schedule(new Map([["tokens", pushRegistry.serialize().tokens]]));
}

function onlineUserIDsFor(orgId) {
  return [...sessions.values()]
    .filter((session) => session.orgId === orgId)
    .map((session) => session.userId);
}

// Only pending high/urgent decisions ring, and never for a user who is
// already connected — their feed shows the card in real time.
function maybeNotify(orgId, card) {
  if (!apns.configured) return;
  if (!shouldNotify({ card, onlineUserIDs: onlineUserIDsFor(orgId) })) return;

  for (const token of pushRegistry.tokensFor(card.recipientUserID)) {
    apns
      .send({
        deviceToken: token,
        title: card.title,
        body: card.summary || "New decision for you",
        payload: { cardID: card.id },
      })
      .then((result) => {
        if (result.prune) {
          pushRegistry.prune(token);
          persistPush();
        }
      })
      .catch(() => {});
  }
}

const persistedDigest = loadPersistedStores(DIGEST_STORE_PATH);
const digestState =
  persistedDigest?.get("lastRunByUser") &&
  typeof persistedDigest.get("lastRunByUser") === "object"
    ? persistedDigest.get("lastRunByUser")
    : {};
const digestPersister = createPersister(DIGEST_STORE_PATH);

function persistDigestState() {
  digestPersister.schedule(new Map([["lastRunByUser", digestState]]));
}

// One digest card per user covering channel activity they haven't seen
// (and didn't write). Low priority: shows in the feed, never pushes.
async function runDigest() {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let created = 0;

  for (const user of orgStore.users()) {
    const since = digestState[user.id] || dayAgo;
    const sections = collectDigestSections({
      channelStore,
      userID: user.id,
      since,
    });
    if (sections.length === 0) continue;

    const digest = await generateDigest({
      sections,
      userName: user.name,
      language: user.language,
      openRouter: openRouterConfig(),
    });
    const card = buildDigestCard({ user, digest, sectionCount: sections.length });

    const store = getStore(ORG_ID);
    upsertCard(store, card);
    persister.schedule(orgStores);
    broadcast(ORG_ID, "card_created", { card });

    digestState[user.id] = now;
    created += 1;
  }

  if (created > 0) {
    persistDigestState();
  }
  return created;
}

if (DIGEST_INTERVAL_MINUTES > 0) {
  setInterval(() => {
    runDigest().catch((error) => console.warn("Digest run failed:", error.message));
  }, DIGEST_INTERVAL_MINUTES * 60 * 1000).unref();
}

// Stuck decisions climb the org graph: past their SLA, the recipient's
// manager gets an actionable copy and the original card is annotated.
async function runEscalations(now = Date.now()) {
  const store = getStore(ORG_ID);
  const overdue = findOverdueCards({ cardsByUser: store, slaMinutes: SLA_MINUTES, now });
  let escalated = 0;

  for (const { card, overdueMinutes } of overdue) {
    card.escalatedAt = new Date(now).toISOString();

    const recipient = orgStore.findUser(card.recipientUserID);
    const manager = orgStore.managerOf(card.recipientUserID);
    if (!recipient || !manager || manager.id === card.recipientUserID) {
      continue; // marked, so we don't rescan it every sweep
    }

    const ageMinutes = (now - Date.parse(card.createdAt)) / 60000;
    card.context = [card.context, `escalated: ${manager.name} notified after ${Math.round(ageMinutes / 60)}h`]
      .filter(Boolean)
      .join("\n");
    broadcast(ORG_ID, "card_updated", { card });

    await deliverCard(
      ORG_ID,
      buildEscalationCard({ card, recipient, manager, ageMinutes })
    );
    escalated += 1;
  }

  if (overdue.length > 0) {
    persister.schedule(orgStores);
  }
  return escalated;
}

if (ESCALATION_INTERVAL_MINUTES > 0) {
  setInterval(() => {
    runEscalations().catch((error) =>
      console.warn("Escalation sweep failed:", error.message)
    );
  }, ESCALATION_INTERVAL_MINUTES * 60 * 1000).unref();
}

const persistedChannels = loadPersistedStores(CHANNELS_STORE_PATH);
const channelStore = createChannelStore(
  persistedChannels ? Object.fromEntries(persistedChannels.entries()) : null
);
const channelPersister = createPersister(CHANNELS_STORE_PATH);

function persistChannels() {
  const serialized = channelStore.serialize();
  channelPersister.schedule(
    new Map([
      ["channels", serialized.channels],
      ["messages", serialized.messages],
    ])
  );
}

function channelIndex() {
  const snapshot = channelStore.snapshot();
  return Object.values(snapshot.channels).map((channel) => ({
    id: channel.id,
    name: channel.name,
    purpose: channel.purpose,
    recent: channelStore
      .recentMessages(channel.id, 3)
      .map((message) => `${message.authorName}: ${message.text.slice(0, 60)}`),
  }));
}

function findChannelByName(name) {
  const snapshot = channelStore.snapshot();
  return Object.values(snapshot.channels).find((channel) => channel.name === name) || null;
}

// Every decision card that knows its home channel leaves a trail in chat:
// the sender's AI posts a log message so the conversation shows the routing.
function logCardToChannel(orgId, card) {
  if (!card.channelID) return;
  const channel = channelStore.getChannel(card.channelID);
  if (!channel) return;

  const senderName = userNameFor(card.senderUserID);
  const recipientName = userNameFor(card.recipientUserID);
  const message = channelStore.addMessage({
    channelID: channel.id,
    authorID: `agent-${String(card.senderUserID).replace("user-", "")}`,
    authorKind: "agent",
    authorName: `${senderName}'s AI`,
    text: `Routed a decision to ${recipientName}: ${card.title}`,
    cardID: card.id,
  });

  if (message) {
    persistChannels();
    broadcast(orgId, "channel_message", { message });
  }
}

// Translate only when the recipient has a language and it plausibly differs
// from the sender's — same-language pairs skip the extra AI hop entirely.
function targetLanguageFor(card) {
  const recipient = orgStore.findUser(card.recipientUserID);
  if (!recipient?.language) return null;
  const sender = orgStore.findUser(card.senderUserID);
  if (sender?.language && sender.language === recipient.language) return null;
  return recipient.language;
}

// Single delivery path for every card that reaches the store: translate for
// the recipient, persist, broadcast, leave the channel trail, maybe push.
async function deliverCard(orgId, card, { log = true } = {}) {
  const translated = await translateCard({
    card,
    targetLanguage: targetLanguageFor(card),
    openRouter: openRouterConfig(),
  });

  const store = getStore(orgId);
  upsertCard(store, translated);
  persister.schedule(orgStores);
  broadcast(orgId, "card_created", { card: translated });
  if (log) {
    logCardToChannel(orgId, translated);
  }
  maybeNotify(orgId, translated);
  return translated;
}

function openRouterConfig() {
  return OPENROUTER_API_KEY
    ? {
        apiKey: OPENROUTER_API_KEY,
        model: OPENROUTER_MODEL,
        appName: OPENROUTER_APP_NAME,
        appUrl: OPENROUTER_APP_URL,
      }
    : null;
}

/** @type {Map<import('ws').WebSocket, { userId: string, orgId: string }>} */
const sessions = new Map();

function getStore(orgId) {
  if (!orgStores.has(orgId)) {
    orgStores.set(orgId, {});
  }
  return orgStores.get(orgId);
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload, eventId: randomUUID() }));
  }
}

function broadcast(orgId, type, payload, except) {
  for (const [socket, session] of sessions.entries()) {
    if (session.orgId !== orgId) continue;
    if (except && socket === except) continue;
    send(socket, type, payload);
  }
}

function upsertCard(store, card) {
  const userId = card.recipientUserID;
  const cards = store[userId] || [];
  const index = cards.findIndex((item) => item.id === card.id);
  if (index >= 0) {
    cards[index] = card;
  } else {
    cards.unshift(card);
  }
  store[userId] = cards;
}

function removeCard(store, cardId, recipientUserID) {
  const cards = store[recipientUserID] || [];
  store[recipientUserID] = cards.filter((item) => item.id !== cardId);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAuthorizedRequest(req) {
  if (!RELAY_TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${RELAY_TOKEN}`;
}

function isAuthorizedJoin(payload) {
  if (!RELAY_TOKEN) return true;
  return payload?.token === RELAY_TOKEN;
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

async function exchangeGitHubCode(code) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: GITHUB_REDIRECT_URI,
    }),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error_description || data.error || "OAuth exchange failed";
    throw new Error(message);
  }

  if (!data.access_token) {
    throw new Error("GitHub did not return an access token.");
  }

  return data.access_token;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      orgId: ORG_ID,
      githubOAuth: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
      aiRouting: Boolean(OPENROUTER_API_KEY),
      aiModel: OPENROUTER_MODEL,
      authRequired: Boolean(RELAY_TOKEN),
      push: apns.configured,
    });
    return;
  }

  if (url.pathname === "/github/webhook" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const signature = req.headers["x-hub-signature-256"];
      if (!verifyWebhookSignature({ payload: raw, signature, secret: GITHUB_WEBHOOK_SECRET })) {
        json(res, 401, { message: "Invalid webhook signature." });
        return;
      }

      const payload = raw ? JSON.parse(raw) : {};
      const event = String(req.headers["x-github-event"] || "");
      const cards = cardsFromWebhook({ event, payload, orgStore });
      for (const card of cards) {
        deliverCard(ORG_ID, card).catch((error) =>
          console.warn("Webhook card delivery failed:", error.message)
        );
      }
      json(res, 200, { cards: cards.length });
    } catch (error) {
      json(res, 400, { message: error.message || "Webhook processing failed." });
    }
    return;
  }

  if (!isAuthorizedRequest(req)) {
    json(res, 401, { message: "Relay token required. Set it in the app's relay settings." });
    return;
  }

  if (url.pathname === "/oauth/github/config" && req.method === "GET") {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      json(res, 503, {
        message: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in server/.env",
      });
      return;
    }

    json(res, 200, {
      clientId: GITHUB_CLIENT_ID,
      redirectUri: GITHUB_REDIRECT_URI,
      scope: GITHUB_OAUTH_SCOPE,
    });
    return;
  }

  if (url.pathname === "/oauth/github/token" && req.method === "POST") {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      json(res, 503, { message: "GitHub OAuth is not configured on the server." });
      return;
    }

    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const code = body.code;

      if (!code) {
        json(res, 400, { message: "Missing OAuth code." });
        return;
      }

      const accessToken = await exchangeGitHubCode(code);
      json(res, 200, {
        accessToken,
        tokenType: "bearer",
      });
    } catch (error) {
      json(res, 400, { message: error.message || "OAuth exchange failed." });
    }
    return;
  }

  if (url.pathname === "/ai/route" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = body.text;
      const sender = body.sender;
      const organization = body.organization;

      if (!text || !sender?.id || !sender?.name) {
        json(res, 400, { message: "Missing text or sender." });
        return;
      }

      const routing = await routeInstruction({
        text,
        sender,
        organization,
        priorityOverride: body.priorityOverride,
        openRouter: openRouterConfig(),
      });
      json(res, 200, routing);
    } catch (error) {
      json(res, 400, { message: error.message || "AI routing failed." });
    }
    return;
  }

  if (url.pathname === "/digest/run" && req.method === "POST") {
    try {
      const created = await runDigest();
      json(res, 200, { digests: created });
    } catch (error) {
      json(res, 400, { message: error.message || "Digest run failed." });
    }
    return;
  }

  if (url.pathname === "/escalations/run" && req.method === "POST") {
    try {
      const escalated = await runEscalations();
      json(res, 200, { escalated });
    } catch (error) {
      json(res, 400, { message: error.message || "Escalation sweep failed." });
    }
    return;
  }

  if (url.pathname === "/push/register" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const registered = pushRegistry.register(body.userId, body.deviceToken);

      if (!registered) {
        json(res, 400, { message: "Valid userId and deviceToken are required." });
        return;
      }

      persistPush();
      json(res, 200, { registered: true, pushEnabled: apns.configured });
    } catch (error) {
      json(res, 400, { message: error.message || "Push registration failed." });
    }
    return;
  }

  if (url.pathname === "/org" && req.method === "GET") {
    json(res, 200, orgStore.snapshot());
    return;
  }

  if (url.pathname === "/org/language" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!orgStore.setLanguage(body.userId, body.language)) {
        json(res, 400, { message: "Valid userId and language are required." });
        return;
      }
      persistOrg();
      broadcast(ORG_ID, "org_updated", orgStore.snapshot());
      json(res, 200, {
        user: orgStore.findUser(body.userId),
        organization: orgStore.snapshot(),
      });
    } catch (error) {
      json(res, 400, { message: error.message || "Could not set language." });
    }
    return;
  }

  if (url.pathname === "/org/members" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const user = orgStore.addMember({
        name: body.name,
        role: body.role,
        team: body.team,
        githubUsername: body.githubUsername,
        language: body.language,
      });

      if (!user) {
        json(res, 400, { message: "Member name and role are required." });
        return;
      }

      persistOrg();
      broadcast(ORG_ID, "org_updated", orgStore.snapshot());
      json(res, 200, { user, organization: orgStore.snapshot() });
    } catch (error) {
      json(res, 400, { message: error.message || "Could not add member." });
    }
    return;
  }

  if (url.pathname === "/ai/ingest" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = body.text;
      const sender = body.sender;

      if (!text || !sender?.id || !sender?.name) {
        json(res, 400, { message: "Missing text or sender." });
        return;
      }

      const classification = await classifyInput({
        text,
        sender,
        channels: channelIndex(),
        openRouter: openRouterConfig(),
      });

      let channel = findChannelByName(classification.channel);
      let isNew = false;
      if (!channel && classification.isNewChannel) {
        channel = channelStore.createChannel({
          name: classification.channel,
          purpose: `Started from ${sender.name}'s update`,
        });
        if (channel) {
          isNew = true;
          persistChannels();
          broadcast(ORG_ID, "channel_created", { channel });
        }
      }
      if (!channel) {
        channel = findChannelByName("general") || channelStore.createChannel({ name: "general" });
      }

      if (classification.kind === "update") {
        const message = channelStore.addMessage({
          channelID: channel.id,
          authorID: sender.id,
          authorKind: "user",
          authorName: sender.name,
          text,
        });
        if (message) {
          persistChannels();
          broadcast(ORG_ID, "channel_message", { message });
        }
        json(res, 200, {
          kind: "update",
          channel: { id: channel.id, name: channel.name, isNew },
        });
        return;
      }

      const routing = await routeInstruction({
        text,
        sender,
        organization: body.organization || null,
        priorityOverride: body.priorityOverride,
        openRouter: openRouterConfig(),
      });

      json(res, 200, {
        kind: "decision",
        channel: { id: channel.id, name: channel.name, isNew },
        routing,
      });
    } catch (error) {
      json(res, 400, { message: error.message || "AI ingest failed." });
    }
    return;
  }

  if (url.pathname === "/ai/reply" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const card = body.card;
      const reply = body.reply;

      if (!card?.title || !reply) {
        json(res, 400, { message: "Missing card or reply." });
        return;
      }

      const interpretation = await interpretReply({
        card,
        reply,
        openRouter: openRouterConfig(),
      });
      json(res, 200, interpretation);
    } catch (error) {
      json(res, 400, { message: error.message || "Reply interpretation failed." });
    }
    return;
  }

  if (url.pathname === "/ai/refine" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const card = body.card;
      const instruction = body.instruction;

      if (!card?.title || !card?.summary || !instruction) {
        json(res, 400, { message: "Missing card or instruction." });
        return;
      }

      const refinement = await refineCard({
        card,
        instruction,
        openRouter: openRouterConfig(),
      });
      json(res, 200, refinement);
    } catch (error) {
      json(res, 400, { message: error.message || "AI refine failed." });
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(ws, "error", { message: "Invalid JSON" });
      return;
    }

    const { type, payload } = message;

    switch (type) {
      case "join": {
        if (!isAuthorizedJoin(payload)) {
          send(ws, "error", { message: "Relay token required or invalid." });
          ws.close(4401, "unauthorized");
          return;
        }
        const userId = payload?.userId;
        const orgId = payload?.orgId || ORG_ID;
        if (!userId) {
          send(ws, "error", { message: "userId required" });
          return;
        }
        sessions.set(ws, { userId, orgId });
        send(ws, "snapshot", { cardsByUser: getStore(orgId) });
        send(ws, "channel_snapshot", channelStore.snapshot());
        broadcast(orgId, "presence", { userId, status: "online" }, ws);
        break;
      }

      case "card_created": {
        const session = sessions.get(ws);
        const card = payload?.card;
        if (!session || !card?.id || !card?.recipientUserID) {
          send(ws, "error", { message: "Invalid card_created payload" });
          return;
        }
        deliverCard(session.orgId, card).catch((error) =>
          console.warn("Card delivery failed:", error.message)
        );
        break;
      }

      case "card_updated": {
        const session = sessions.get(ws);
        const card = payload?.card;
        if (!session || !card?.id || !card?.recipientUserID) {
          send(ws, "error", { message: "Invalid card_updated payload" });
          return;
        }
        const store = getStore(session.orgId);
        upsertCard(store, card);
        persister.schedule(orgStores);
        broadcast(session.orgId, "card_updated", { card });
        break;
      }

      case "card_deleted": {
        const session = sessions.get(ws);
        const cardId = payload?.cardId;
        const recipientUserID = payload?.recipientUserID;
        if (!session || !cardId || !recipientUserID) {
          send(ws, "error", { message: "Invalid card_deleted payload" });
          return;
        }
        const store = getStore(session.orgId);
        removeCard(store, cardId, recipientUserID);
        persister.schedule(orgStores);
        broadcast(session.orgId, "card_deleted", { cardId, recipientUserID });
        break;
      }

      case "channel_create": {
        const session = sessions.get(ws);
        if (!session) {
          send(ws, "error", { message: "Not joined" });
          return;
        }
        const channel = channelStore.createChannel({
          name: payload?.name,
          purpose: payload?.purpose,
        });
        if (!channel) {
          send(ws, "error", { message: "Invalid channel name" });
          return;
        }
        persistChannels();
        broadcast(session.orgId, "channel_created", { channel });
        break;
      }

      case "channel_message": {
        const session = sessions.get(ws);
        const channelID = payload?.channelID;
        const text = payload?.text;
        if (!session || !channelID || !text) {
          send(ws, "error", { message: "Invalid channel_message payload" });
          return;
        }
        const channel = channelStore.getChannel(channelID);
        if (!channel) {
          send(ws, "error", { message: "Unknown channel" });
          return;
        }

        const message = channelStore.addMessage({
          channelID,
          authorID: session.userId,
          authorKind: "user",
          authorName: userNameFor(session.userId),
          text,
        });
        if (!message) return;
        persistChannels();
        broadcast(session.orgId, "channel_message", { message });

        const mention = parseAgentMention(message.text);
        if (mention) {
          respondAsAgent({ orgId: session.orgId, channel, message, mention }).catch(
            (error) => console.warn("Agent response failed:", error.message)
          );
        }
        break;
      }

      case "clear_store": {
        const session = sessions.get(ws);
        if (!session) {
          send(ws, "error", { message: "Not joined" });
          return;
        }
        orgStores.set(session.orgId, {});
        persister.schedule(orgStores);
        broadcast(session.orgId, "snapshot", { cardsByUser: {} });
        break;
      }

      default:
        send(ws, "error", { message: `Unknown type: ${type}` });
    }
  });

  ws.on("close", () => {
    const session = sessions.get(ws);
    if (session) {
      broadcast(session.orgId, "presence", { userId: session.userId, status: "offline" }, ws);
      sessions.delete(ws);
    }
  });
});

// An @-mentioned agent replies in the channel with conversation context.
// When it files a decision, the instruction goes through the same routing
// pipeline as "Tell your AI" and the card lands in the recipient's feed.
async function respondAsAgent({ orgId, channel, message, mention }) {
  const reply = await generateAgentReply({
    agentName: mention.agentName,
    channelName: channel.name,
    recentMessages: channelStore.recentMessages(channel.id),
    message,
    language: orgStore.findUser(message.authorID)?.language,
    openRouter: openRouterConfig(),
  });

  let toolCalls;
  let cardID;

  if (reply.instruction) {
    const sender = {
      id: message.authorID,
      name: message.authorName,
      role: orgStore.findUser(message.authorID)?.role || "Member",
    };
    const routing = await routeInstruction({
      text: reply.instruction,
      sender,
      organization: null,
      openRouter: openRouterConfig(),
    });

    const card = {
      id: `card-${randomUUID()}`,
      recipientUserID: routing.recipientUserID,
      senderUserID: message.authorID,
      type: routing.cardType,
      title: routing.title,
      summary: routing.summary,
      context: routing.context,
      status: "pending",
      priority: routing.priority,
      createdAt: new Date().toISOString(),
      agentRoute: `${mention.agentName} → ${userNameFor(routing.recipientUserID)}'s AI`,
      routingReason: `Filed from #${channel.name} by ${mention.agentName}`,
      sourceInstruction: reply.instruction,
      channelID: channel.id,
    };

    // The agent already narrates the routing in its chat reply — skip the
    // extra channel log line.
    await deliverCard(orgId, card, { log: false });

    cardID = card.id;
    toolCalls = [
      {
        name: "create_decision_card",
        label: "Filed decision",
        detail: `${userNameFor(routing.recipientUserID)} · ${routing.cardType}`,
      },
    ];
  }

  const agentMessage = channelStore.addMessage({
    channelID: channel.id,
    authorID: mention.ownerID ? `agent-${mention.ownerID.replace("user-", "")}` : "agent-team",
    authorKind: "agent",
    authorName: mention.agentName,
    text: reply.text,
    toolCalls,
    cardID,
  });

  if (agentMessage) {
    persistChannels();
    broadcast(orgId, "channel_message", { message: agentMessage });
  }
}

function shutdown() {
  persister.flushNow(orgStores);
  const serializedChannels = channelStore.serialize();
  channelPersister.flushNow(
    new Map([
      ["channels", serializedChannels.channels],
      ["messages", serializedChannels.messages],
    ])
  );
  const serializedOrg = orgStore.serialize();
  orgPersister.flushNow(
    new Map([
      ["users", serializedOrg.users],
      ["nodes", serializedOrg.nodes],
      ["edges", serializedOrg.edges],
    ])
  );
  pushPersister.flushNow(new Map([["tokens", pushRegistry.serialize().tokens]]));
  digestPersister.flushNow(new Map([["lastRunByUser", digestState]]));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`Relay listening on http://127.0.0.1:${PORT}`);
  console.log(`WebSocket: ws://127.0.0.1:${PORT}`);
  console.log(
    GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
      ? "GitHub OAuth: configured"
      : "GitHub OAuth: missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET"
  );
  console.log(
    OPENROUTER_API_KEY
      ? `AI routing: OpenRouter (${OPENROUTER_MODEL})`
      : "AI routing: missing OPENROUTER_API_KEY"
  );
  console.log(RELAY_TOKEN ? "Relay auth: token required" : "Relay auth: open (set RELAY_TOKEN before deploying)");
  console.log(apns.configured ? "Push: APNs configured" : "Push: off (set APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)");
  console.log(`Card store: ${STORE_PATH}`);
});
