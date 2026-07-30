import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { routeInstruction, refineCard, userNameFor } from "./agentTools.js";
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

const STORE_PATH =
  process.env.CARDS_STORE_PATH || join(__dirname, "data", "cards.json");
const CHANNELS_STORE_PATH =
  process.env.CHANNELS_STORE_PATH || join(__dirname, "data", "channels.json");

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
    });
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
        const store = getStore(session.orgId);
        upsertCard(store, card);
        persister.schedule(orgStores);
        broadcast(session.orgId, "card_created", { card });
        logCardToChannel(session.orgId, card);
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
    openRouter: openRouterConfig(),
  });

  let toolCalls;
  let cardID;

  if (reply.instruction) {
    const sender = {
      id: message.authorID,
      name: message.authorName,
      role: "Member",
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

    const store = getStore(orgId);
    upsertCard(store, card);
    persister.schedule(orgStores);
    broadcast(orgId, "card_created", { card });

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
  const serialized = channelStore.serialize();
  channelPersister.flushNow(
    new Map([
      ["channels", serialized.channels],
      ["messages", serialized.messages],
    ])
  );
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
  console.log(`Card store: ${STORE_PATH}`);
});
