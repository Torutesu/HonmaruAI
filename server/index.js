import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { routeInstruction } from "./agentTools.js";
import { uploadMedia, serveMedia } from "./media.js";
import { toolManifest, PROTOCOL_VERSION } from "./agui/tools.js";
import { runError, toolCallResult } from "./agui/events.js";
import {
  joinEvents,
  upsertEvents,
  removeEvents,
  clearEvents,
  presenceEvents,
  contextEvents,
  applyDecision,
  applyRollback,
} from "./agui/adapter.js";
import { parseEmailMessage, validateMailgunSignature } from "./connectors/email.js";
import { createEmailDecisionCard } from "./connectors/email-handler.js";

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

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const GITHUB_REDIRECT_URI =
  process.env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback";
const GITHUB_OAUTH_SCOPE = process.env.GITHUB_OAUTH_SCOPE || "repo";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
// An OpenAI key takes precedence when both are present: it is the more explicit
// choice, and having two configured is otherwise ambiguous.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "TikTok for Work";
const OPENROUTER_APP_URL = process.env.OPENROUTER_APP_URL || "http://localhost:8080";

/** Which provider routing should call, or null to fall back to keyword routing. */
function llmConfig() {
  if (OPENAI_API_KEY) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
    };
  }
  if (OPENROUTER_API_KEY) {
    return {
      providerName: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: OPENROUTER_API_KEY,
      model: OPENROUTER_MODEL,
      appName: OPENROUTER_APP_NAME,
      appUrl: OPENROUTER_APP_URL,
    };
  }
  return null;
}

const initialCards = {};

/** @type {Map<string, Record<string, object[]>>} */
const orgStores = new Map([[ORG_ID, structuredClone(initialCards)]]);

/** Per-user curated context ("profile.md" behind the UI). */
/** @type {Map<string, Record<string, object>>} */
const orgContexts = new Map();

function getContexts(orgId) {
  if (!orgContexts.has(orgId)) {
    orgContexts.set(orgId, {});
  }
  return orgContexts.get(orgId);
}

/** @type {Map<import('ws').WebSocket, { userId: string, orgId: string, agui: boolean }>} */
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
    if (session.agui) continue; // AG-UI sessions are fed through publish* below
    send(socket, type, payload);
  }
}

function sendEvents(ws, events) {
  if (ws.readyState !== ws.OPEN) return;
  for (const event of events) {
    ws.send(JSON.stringify(event));
  }
}

function broadcastEvents(orgId, events, { recipientUserID, recipientEvents, except } = {}) {
  for (const [socket, session] of sessions.entries()) {
    if (session.orgId !== orgId || !session.agui) continue;
    if (except && socket === except) continue;
    sendEvents(socket, events);
    if (recipientEvents && session.userId === recipientUserID) {
      sendEvents(socket, recipientEvents);
    }
  }
}

// One mutation, both dialects: legacy clients get the old message,
// AG-UI clients get STATE_DELTA (+ request_decision for the recipient).
function publishUpsert(orgId, card, isNew) {
  broadcast(orgId, isNew ? "card_created" : "card_updated", { card });
  const { forEveryone, forRecipient } = upsertEvents(card, { isNew });
  broadcastEvents(orgId, forEveryone, {
    recipientUserID: card.recipientUserID,
    recipientEvents: forRecipient,
  });
}

function publishRemove(orgId, cardId, recipientUserID) {
  broadcast(orgId, "card_deleted", { cardId, recipientUserID });
  broadcastEvents(orgId, removeEvents(cardId));
}

function publishClear(orgId) {
  broadcast(orgId, "snapshot", { cardsByUser: {} });
  broadcastEvents(orgId, clearEvents());
}

function publishPresence(orgId, userId, status, except) {
  broadcast(orgId, "presence", { userId, status }, except);
  broadcastEvents(orgId, presenceEvents(userId, status), { except });
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

  if (url.pathname === "/agui/tools" && req.method === "GET") {
    json(res, 200, toolManifest());
    return;
  }

  // Reference AG-UI web client (no build step). Production path: CopilotKit.
  if ((url.pathname === "/" || url.pathname === "/web") && req.method === "GET") {
    const file = join(__dirname, "..", "web", "index.html");
    if (existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(file));
      return;
    }
  }

  if (url.pathname === "/media" && req.method === "POST") {
    // The phone needs an address it can reach, which is the host it dialled —
    // not the loopback the server sees itself on.
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    uploadMedia(req, res, { publicBaseURL: `http://${host}` });
    return;
  }

  if (url.pathname.startsWith("/media/") && req.method === "GET") {
    serveMedia(req, res, url.pathname.slice("/media/".length));
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      orgId: ORG_ID,
      githubOAuth: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
      // The app decides whether to show AI routing as live from this, so it
      // has to reflect the provider actually configured, not just OpenRouter.
      aiRouting: Boolean(llmConfig()),
      aiModel: llmConfig()?.model || OPENROUTER_MODEL,
    });
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
        // The app tells us what language the person deciding reads in.
        readerLanguage: body.readerLanguage,
        openRouter: llmConfig(),
      });
      json(res, 200, routing);
    } catch (error) {
      json(res, 400, { message: error.message || "AI routing failed." });
    }
    return;
  }

  if (url.pathname === "/webhooks/email" && req.method === "POST") {
    try {
      const raw = await readBody(req);

      // Mailgun posts form-encoded fields; our test harness posts plain
      // JSON { raw: "<rfc822 message>" }. Accept both so curl/tests are easy.
      let rawMessage;
      let timestamp;
      let token;
      let signature;
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("application/json")) {
        const body = raw ? JSON.parse(raw) : {};
        rawMessage = body["body-mime"] || body.raw;
        ({ timestamp, token, signature } = body);
      } else {
        const params = new URLSearchParams(raw);
        rawMessage = params.get("body-mime");
        timestamp = params.get("timestamp");
        token = params.get("token");
        signature = params.get("signature");
      }

      if (!rawMessage) {
        json(res, 400, { message: "Missing email body (body-mime/raw)." });
        return;
      }

      if (!validateMailgunSignature(timestamp, token, signature)) {
        json(res, 401, { message: "Invalid webhook signature." });
        return;
      }

      const parsed = await parseEmailMessage(rawMessage);
      console.log(`Received email: "${parsed.subject}" from ${parsed.from}`);

      // Respond to the webhook immediately; Mailgun retries on non-2xx and
      // on timeout, so keep the handler fast and do the rest inline (this
      // relay is single-request-at-a-time anyway, no queue to hand off to).
      json(res, 200, { status: "received" });

      // Recipient resolution is a stand-in for real org-membership lookup —
      // routes every decision-worthy email to the org's first known member.
      const store = getStore(ORG_ID);
      const recipientUserID = Object.keys(store)[0] || "user-alice";

      const card = await createEmailDecisionCard(parsed, ORG_ID, { recipientUserID });
      if (card) {
        upsertCard(store, card);
        publishUpsert(ORG_ID, card, true);
        console.log(`Card ${card.id} broadcast to ${recipientUserID}`);
      }
    } catch (error) {
      console.error("/webhooks/email error:", error.message);
      if (!res.headersSent) json(res, 400, { message: error.message || "Email webhook failed." });
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
        const userId = payload?.userId;
        const orgId = payload?.orgId || ORG_ID;
        const agui = payload?.protocol === PROTOCOL_VERSION;
        if (!userId) {
          send(ws, "error", { message: "userId required" });
          return;
        }
        sessions.set(ws, { userId, orgId, agui });
        if (agui) {
          sendEvents(ws, joinEvents(userId, getStore(orgId), getContexts(orgId)));
        } else {
          send(ws, "snapshot", { cardsByUser: getStore(orgId) });
        }
        publishPresence(orgId, userId, "online", ws);
        break;
      }

      // AG-UI: the human answered a request_decision tool call.
      case "tool_result": {
        const session = sessions.get(ws);
        if (!session) {
          sendEvents(ws, [runError("Not joined")]);
          return;
        }
        try {
          const content =
            typeof payload?.content === "string"
              ? JSON.parse(payload.content)
              : payload?.content;
          const store = getStore(session.orgId);
          const result = applyDecision(store, content);

          // Echo the result onto the org stream so every device (and the
          // sender's AI) sees the decision land against its toolCallId.
          if (payload?.toolCallId) {
            broadcastEvents(session.orgId, [
              toolCallResult(payload.toolCallId, content),
            ]);
          }

          if (result.removed) {
            publishRemove(session.orgId, content.cardId, result.card.recipientUserID);
          } else if (!result.unchanged) {
            publishUpsert(session.orgId, result.card, false);
          }
        } catch (error) {
          sendEvents(ws, [runError(error.message || "tool_result failed")]);
        }
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
        const existed = (store[card.recipientUserID] || []).some(
          (item) => item.id === card.id
        );
        upsertCard(store, card);
        publishUpsert(session.orgId, card, !existed);
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
        publishUpsert(session.orgId, card, false);
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
        publishRemove(session.orgId, cardId, recipientUserID);
        break;
      }

      // AG-UI phase 2: curated context changed on one device →
      // STATE_DELTA on /context/{userId} to every AG-UI session.
      case "context_updated": {
        const session = sessions.get(ws);
        const context = payload?.context;
        if (!session || typeof context !== "object" || context === null) {
          send(ws, "error", { message: "Invalid context_updated payload" });
          return;
        }
        const userId = payload?.userId || session.userId;
        const contexts = getContexts(session.orgId);
        const isNew = !(userId in contexts);
        contexts[userId] = context;
        broadcastEvents(session.orgId, contextEvents(userId, context, { isNew }));
        break;
      }

      // AG-UI phase 2: undo a decision. The card returns to pending; a
      // CUSTOM decision_rolled_back notice lets the sender's agent react.
      case "rollback": {
        const session = sessions.get(ws);
        const cardId = payload?.cardId;
        if (!session || !cardId) {
          send(ws, "error", { message: "Invalid rollback payload" });
          return;
        }
        try {
          const store = getStore(session.orgId);
          const { card, notice } = applyRollback(store, cardId, session.userId);
          broadcastEvents(session.orgId, [notice]);
          publishUpsert(session.orgId, card, false);
        } catch (error) {
          if (session.agui) {
            sendEvents(ws, [runError(error.message || "rollback failed")]);
          } else {
            send(ws, "error", { message: error.message || "rollback failed" });
          }
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
        publishClear(session.orgId);
        break;
      }

      default:
        send(ws, "error", { message: `Unknown type: ${type}` });
    }
  });

  ws.on("close", () => {
    const session = sessions.get(ws);
    if (session) {
      sessions.delete(ws);
      publishPresence(session.orgId, session.userId, "offline");
    }
  });
});

server.listen(PORT, () => {
  console.log(`Relay listening on http://127.0.0.1:${PORT}`);
  console.log(`WebSocket: ws://127.0.0.1:${PORT}`);
  console.log(
    GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
      ? "GitHub OAuth: configured"
      : "GitHub OAuth: missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET"
  );
  console.log(
    llmConfig()
      ? `AI routing: ${llmConfig().providerName} (${llmConfig().model})`
      : "AI routing: off (set OPENAI_API_KEY or OPENROUTER_API_KEY)"
  );
});
