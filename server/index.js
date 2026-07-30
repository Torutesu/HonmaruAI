import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { routeInstruction } from "./agentTools.js";

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
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "TikTok for Work";
const OPENROUTER_APP_URL = process.env.OPENROUTER_APP_URL || "http://localhost:8080";

const initialCards = {};

/** @type {Map<string, Record<string, object[]>>} */
const orgStores = new Map([[ORG_ID, structuredClone(initialCards)]]);

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
        openRouter: OPENROUTER_API_KEY
          ? {
              apiKey: OPENROUTER_API_KEY,
              model: OPENROUTER_MODEL,
              appName: OPENROUTER_APP_NAME,
              appUrl: OPENROUTER_APP_URL,
            }
          : null,
      });
      json(res, 200, routing);
    } catch (error) {
      json(res, 400, { message: error.message || "AI routing failed." });
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
        if (!userId) {
          send(ws, "error", { message: "userId required" });
          return;
        }
        sessions.set(ws, { userId, orgId });
        send(ws, "snapshot", { cardsByUser: getStore(orgId) });
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
        broadcast(session.orgId, "card_created", { card });
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
        broadcast(session.orgId, "card_deleted", { cardId, recipientUserID });
        break;
      }

      case "clear_store": {
        const session = sessions.get(ws);
        if (!session) {
          send(ws, "error", { message: "Not joined" });
          return;
        }
        orgStores.set(session.orgId, {});
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
});
