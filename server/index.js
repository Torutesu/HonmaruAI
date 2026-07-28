import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

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

const initialCards = {
  "user-bob": [
    {
      id: "card-seed-1",
      recipientUserID: "user-bob",
      senderUserID: "user-alice",
      type: "approval",
      title: "Approve onboarding PR",
      summary: "Review onboarding redesign before tomorrow's merge window.",
      context: "PR #42 · QA passed on staging",
      status: "pending",
      priority: "high",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      githubIssueNumber: null,
      githubIssueURL: null,
      agentRoute: "Alice's AI → Bob's AI",
      routingReason: "Approval authority on Onboarding v2",
    },
  ],
  "user-alice": [
    {
      id: "card-seed-2",
      recipientUserID: "user-alice",
      senderUserID: "user-bob",
      type: "task",
      title: "Auth latency regression",
      summary: "p95 on auth endpoint up 18% after last deploy.",
      context: "Hotfix branch recommended before Friday demo",
      status: "pending",
      priority: "urgent",
      createdAt: new Date(Date.now() - 1_800_000).toISOString(),
      githubIssueNumber: null,
      githubIssueURL: null,
      agentRoute: "Bob's AI → Alice's AI",
      routingReason: "You are Bob's manager",
    },
  ],
};

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

function organizationContext(organization) {
  const nodes = (organization?.nodes || [])
    .map((node) => `- ${node.id}: ${node.label} (${node.kind})`)
    .join("\n");
  const edges = (organization?.edges || [])
    .map((edge) => {
      const from =
        organization.nodes?.find((node) => node.id === edge.fromID)?.label ||
        edge.fromID;
      const to =
        organization.nodes?.find((node) => node.id === edge.toID)?.label ||
        edge.toID;
      return `- ${from} ${edge.kind} ${to}`;
    })
    .join("\n");
  return `Nodes:\n${nodes}\nEdges:\n${edges}`;
}

function userNameFor(userID) {
  if (userID === "user-alice") return "Alice";
  if (userID === "user-bob") return "Bob";
  return userID;
}

function parseRoutingJSON(content) {
  const trimmed = String(content || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

function validateRouting(routingJSON, sender) {
  const allowedRecipients = new Set(["user-alice", "user-bob"]);
  const allowedTypes = new Set([
    "approval",
    "delegation",
    "notification",
    "task",
    "revision",
  ]);
  const allowedPriorities = new Set(["low", "medium", "high", "urgent"]);

  const recipientUserID = routingJSON.recipientUserID;
  const cardType = routingJSON.cardType;
  const title = routingJSON.title;
  const summary = routingJSON.summary;
  const context = routingJSON.context;
  const priority = routingJSON.priority;

  if (!allowedRecipients.has(recipientUserID)) {
    throw new Error("AI picked an invalid recipient.");
  }
  if (!allowedTypes.has(cardType)) {
    throw new Error("AI returned an invalid card type.");
  }
  if (!allowedPriorities.has(priority)) {
    throw new Error("AI returned an invalid priority.");
  }
  if (!title || !summary || !context) {
    throw new Error("AI returned incomplete routing fields.");
  }

  const recipientName = userNameFor(recipientUserID);
  const agentRoute =
    routingJSON.agentRoute || `${sender.name}'s AI → ${recipientName}'s AI`;
  const routingReason =
    routingJSON.routingReason || "Best match for this decision in org graph";

  return {
    recipientUserID,
    cardType,
    title,
    summary,
    context,
    priority,
    agentRoute,
    routingReason,
  };
}

async function routeInstructionWithOpenRouter({ text, sender, organization }) {
  const orgContext = organizationContext(organization);
  const systemPrompt = `You route workplace instructions between AI agents in an organization.
Return JSON only with keys:
recipientUserID, cardType, title, summary, context, priority, agentRoute, routingReason

recipientUserID must be one of: user-alice, user-bob
cardType must be one of: approval, delegation, notification, task, revision
priority must be one of: low, medium, high, urgent
agentRoute format: "{Sender}'s AI → {Recipient}'s AI"

Use organization context to pick the right decision owner.
summary should be concise decision-ready text, not the raw user message.
context should include role-relevant details only.
routingReason should explain why this recipient owns the decision (one short sentence).`;

  const userPrompt = `Sender: ${sender.name} (${sender.id}, ${sender.role})
Instruction: ${text}

Organization:
${orgContext}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_APP_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "OpenRouter request failed.";
    throw new Error(message);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter returned an empty routing response.");
  }

  const routingJSON = parseRoutingJSON(content);
  return validateRouting(routingJSON, sender);
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
    if (!OPENROUTER_API_KEY) {
      json(res, 503, {
        message: "Set OPENROUTER_API_KEY in server/.env",
      });
      return;
    }

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

      const routing = await routeInstructionWithOpenRouter({
        text,
        sender,
        organization,
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
