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
import { createAPNS, createWebPush, createPushRegistry, shouldNotify } from "./push.js";
import {
  createSessionStore,
  serializeCookie,
  clearCookie,
  parseCookies,
  originFor,
} from "./session.js";
import { resolveStaticFile, serveStaticFile } from "./static.js";
import * as gh from "./githubProxy.js";
import { collectDigestSections, generateDigest, buildDigestCard } from "./digest.js";
import { translateCard } from "./translate.js";
import { verifyWebhookSignature, cardsFromWebhook } from "./githubWebhook.js";
import { parseSLAConfig, findOverdueCards, buildEscalationCard } from "./escalation.js";
import {
  createMemoryStore,
  recordableTransition,
  recommendDecision,
} from "./memory.js";
import { buildSources } from "./provenance.js";
import { createNotion, notionPageIdFromUrl, resolveNotionSources } from "./notion.js";
import {
  DECISION_ACTIONS,
  findCard,
  applyDecision,
  needsGitHubSync,
  issueTitle,
  issueBody,
  githubStateFor,
} from "./decisions.js";
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

// Notion integration token (server-side only — the browser never sees it).
// Unset means cards keep the link-extraction provenance they had before.
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
// Overridable so the E2E suite can point at a fixture workspace instead of
// the live API; unset everywhere else.
const NOTION_API_BASE = process.env.NOTION_API_BASE || undefined;

const STORE_PATH =
  process.env.CARDS_STORE_PATH || join(__dirname, "data", "cards.json");
const CHANNELS_STORE_PATH =
  process.env.CHANNELS_STORE_PATH || join(__dirname, "data", "channels.json");
const ORG_STORE_PATH =
  process.env.ORG_STORE_PATH || join(__dirname, "data", "org.json");
const PUSH_STORE_PATH =
  process.env.PUSH_STORE_PATH || join(__dirname, "data", "push.json");
const SESSIONS_STORE_PATH =
  process.env.SESSIONS_STORE_PATH || join(__dirname, "data", "sessions.json");

// Web client hosted by the relay itself → same origin, so no CORS, and the
// GitHub token can stay server-side behind an httpOnly session cookie.
const WEB_DIST_PATH =
  process.env.WEB_DIST_PATH || join(__dirname, "..", "web", "dist");
// Explicit public origin when behind a proxy/CDN (used for OAuth redirects).
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "";
// Secure cookies are required in production; localhost http needs them off.
const SECURE_COOKIES = process.env.INSECURE_COOKIES !== "true";
const DIGEST_STORE_PATH =
  process.env.DIGEST_STORE_PATH || join(__dirname, "data", "digest.json");
const MEMORY_STORE_PATH =
  process.env.MEMORY_STORE_PATH || join(__dirname, "data", "memory.json");
// 0 disables the periodic digest; POST /digest/run always works.
const DIGEST_INTERVAL_MINUTES = Number(process.env.DIGEST_INTERVAL_MINUTES || 0);

// SLA table (override e.g. SLA_MINUTES="urgent:60,high:240") and how often
// to sweep for breaches. 0 disables the sweep; POST /escalations/run always works.
const SLA_MINUTES = parseSLAConfig(process.env.SLA_MINUTES);
const ESCALATION_INTERVAL_MINUTES = Number(process.env.ESCALATION_INTERVAL_MINUTES || 15);

// Password-less sign-in for local demos and the browser E2E suite. Never on
// by default, and never in production even if the flag is set.
const DEV_AUTH = process.env.DEV_AUTH === "true" && process.env.NODE_ENV !== "production";

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
const webPush = createWebPush(process.env);
const notion = createNotion({ token: NOTION_TOKEN, baseUrl: NOTION_API_BASE });

const persistedSessions = loadPersistedStores(SESSIONS_STORE_PATH);
const sessionStore = createSessionStore(
  persistedSessions ? Object.fromEntries(persistedSessions.entries()) : null
);
const sessionPersister = createPersister(SESSIONS_STORE_PATH);

function persistSessions() {
  sessionPersister.schedule(
    new Map([["sessions", sessionStore.serialize().sessions]])
  );
}

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
  if (!apns.configured && !webPush.configured) return;
  if (!shouldNotify({ card, onlineUserIDs: onlineUserIDsFor(orgId) })) return;

  const title = card.title;
  const body = card.summary || "New decision for you";

  for (const target of pushRegistry.targetsFor(card.recipientUserID)) {
    const delivery =
      target.platform === "web"
        ? webPush.configured &&
          webPush.send({
            subscription: target.subscription,
            title,
            body,
            payload: { cardID: card.id },
          })
        : apns.configured &&
          apns.send({
            deviceToken: target.token,
            title,
            body,
            payload: { cardID: card.id },
          });

    if (!delivery) continue;

    delivery
      .then((result) => {
        if (result.prune) {
          pushRegistry.prune(
            target.platform === "web" ? target.subscription.endpoint : target.token
          );
          persistPush();
        }
      })
      .catch(() => {});
  }
}

const persistedMemory = loadPersistedStores(MEMORY_STORE_PATH);
const memoryStore = createMemoryStore(
  persistedMemory ? Object.fromEntries(persistedMemory.entries()) : null
);
const memoryPersister = createPersister(MEMORY_STORE_PATH);

function persistMemory() {
  memoryPersister.schedule(
    new Map([["entries", memoryStore.serialize().entries]])
  );
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
    const card = buildDigestCard({ user, digest, sectionCount: sections.length, sections });

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

  // One-tap provenance: channel conversation + referenced documents, then
  // Notion resolves those documents to real titles and finds the page this
  // decision is about when nobody linked one. Best-effort by construction.
  const sources = buildSources({ card: translated, channelStore }) || [];
  let enriched = sources;
  try {
    enriched = await resolveNotionSources({ card: translated, sources, notion });
  } catch (error) {
    console.warn("Notion provenance skipped:", error.message);
  }
  if (enriched.length > 0) {
    translated.sources = enriched;
  }

  // Agent memory: annotate decidable cards with how this person usually
  // decides similar requests — advisory, one tap to accept, human decides.
  if (
    translated.status === "pending" &&
    translated.type !== "notification" &&
    translated.recipientUserID !== translated.senderUserID
  ) {
    try {
      const recommendation = await recommendDecision({
        card: translated,
        history: memoryStore.entriesFor(translated.recipientUserID),
        language: orgStore.findUser(translated.recipientUserID)?.language,
        openRouter: openRouterConfig(),
      });
      if (recommendation) {
        translated.recommendation = recommendation;
      }
    } catch (error) {
      console.warn("Recommendation skipped:", error.message);
    }
  }

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

const API_PREFIXES = [
  "/ai/",
  "/org",
  "/cards/",
  "/push/",
  "/digest/",
  "/escalations/",
  "/oauth/",
  "/sources/",
];

export function isApiPath(pathname) {
  return API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Two ways in: the relay token (native clients) or a browser session cookie
// (web client — it must never hold the relay token in JavaScript).
function isAuthorizedRequest(req) {
  if (!RELAY_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header === `Bearer ${RELAY_TOKEN}`) return true;
  return Boolean(sessionStore.fromRequest(req));
}

function isAuthorizedJoin(payload, req) {
  if (!RELAY_TOKEN) return true;
  if (payload?.token === RELAY_TOKEN) return true;
  // Browsers can't set WebSocket headers, but same-origin cookies ride along.
  return Boolean(req && sessionStore.fromRequest(req));
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location, cookie) {
  res.writeHead(302, {
    Location: location,
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
  res.end();
}

async function exchangeGitHubCode(code, redirectUri = GITHUB_REDIRECT_URI) {
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
      redirect_uri: redirectUri,
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
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
      push: { apns: apns.configured, web: webPush.configured },
      notion: notion.configured,
    });
    return;
  }

  // ---- Browser session auth (web client) -------------------------------
  // These endpoints are cookie-authenticated, not bearer-authenticated:
  // a browser redirect can't carry the relay token.

  // Sign in as an org member without GitHub. Exists so the browser E2E suite
  // can reach the app at all; refused unless DEV_AUTH is explicitly on and we
  // are not in production, because it is an unauthenticated session grant.
  if (url.pathname === "/auth/dev" && req.method === "GET") {
    if (!DEV_AUTH) {
      json(res, 404, { message: "Not found." });
      return;
    }
    const user = orgStore.findUser(url.searchParams.get("user"));
    if (!user) {
      json(res, 400, { message: "Unknown org member." });
      return;
    }
    const sessionId = sessionStore.create({
      userId: user.id,
      githubToken: "",
      githubLogin: user.githubUsername || null,
    });
    persistSessions();
    redirect(res, "/", serializeCookie(sessionStore.cookieName, sessionId, { secure: SECURE_COOKIES }));
    return;
  }

  if (url.pathname === "/auth/github/start" && req.method === "GET") {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      json(res, 503, { message: "GitHub OAuth is not configured on the server." });
      return;
    }

    const state = sessionStore.beginAuth();
    const redirectUri = `${originFor(req, PUBLIC_ORIGIN)}/auth/github/callback`;
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", GITHUB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
    authorize.searchParams.set("state", state);

    redirect(res, authorize.toString());
    return;
  }

  if (url.pathname === "/auth/github/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state || !sessionStore.consumeAuth(state)) {
      json(res, 400, { message: "Invalid or expired OAuth state." });
      return;
    }

    try {
      const redirectUri = `${originFor(req, PUBLIC_ORIGIN)}/auth/github/callback`;
      const githubToken = await exchangeGitHubCode(code, redirectUri);
      const viewer = await gh.getViewer(githubToken);

      // Bind to the org member whose githubUsername matches; otherwise the
      // client shows the member picker (keeps the demo org usable).
      const member = orgStore.findByGitHub(viewer.login);
      const sessionId = sessionStore.create({
        userId: member?.id || null,
        githubToken,
        githubLogin: viewer.login,
      });
      persistSessions();

      redirect(
        res,
        "/",
        serializeCookie(sessionStore.cookieName, sessionId, { secure: SECURE_COOKIES })
      );
    } catch (error) {
      json(res, 400, { message: error.message || "OAuth exchange failed." });
    }
    return;
  }

  if (url.pathname === "/auth/me" && req.method === "GET") {
    const found = sessionStore.fromRequest(req);
    if (!found) {
      json(res, 401, { message: "Not signed in." });
      return;
    }
    json(res, 200, {
      githubLogin: found.session.githubLogin,
      user: found.session.userId ? orgStore.findUser(found.session.userId) : null,
      repository: found.session.repository,
      organization: orgStore.snapshot(),
      push: { web: webPush.configured, publicKey: webPush.publicKey || null },
    });
    return;
  }

  if (url.pathname === "/auth/session" && req.method === "POST") {
    // Pick the org member for this session (member picker / demo switching).
    const found = sessionStore.fromRequest(req);
    if (!found) {
      json(res, 401, { message: "Not signed in." });
      return;
    }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const user = orgStore.findUser(body.userId);
      if (!user) {
        json(res, 400, { message: "Unknown org member." });
        return;
      }
      found.session.userId = user.id;
      if (body.repository) sessionStore.setRepository(found.id, body.repository);
      persistSessions();
      json(res, 200, { user, repository: found.session.repository });
    } catch (error) {
      json(res, 400, { message: error.message || "Could not update session." });
    }
    return;
  }

  if (url.pathname === "/auth/signout" && req.method === "POST") {
    const found = sessionStore.fromRequest(req);
    if (found) {
      sessionStore.destroy(found.id);
      persistSessions();
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": clearCookie(sessionStore.cookieName, { secure: SECURE_COOKIES }),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- GitHub proxy (browser never holds a GitHub token) ---------------

  if (url.pathname.startsWith("/github/") && url.pathname !== "/github/webhook") {
    const found = sessionStore.fromRequest(req);
    if (!found) {
      json(res, 401, { message: "Not signed in." });
      return;
    }
    const { session } = found;

    try {
      if (url.pathname === "/github/repos" && req.method === "GET") {
        json(res, 200, { repositories: await gh.listRepositories(session.githubToken) });
        return;
      }

      if (url.pathname === "/github/repo" && req.method === "POST") {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (!body.repository) {
          json(res, 400, { message: "repository is required." });
          return;
        }
        sessionStore.setRepository(found.id, body.repository);
        persistSessions();
        json(res, 200, { repository: body.repository });
        return;
      }

      const issueMatch = url.pathname.match(/^\/github\/issues(?:\/(\d+))?$/);
      if (issueMatch) {
        const number = issueMatch[1] ? Number(issueMatch[1]) : null;

        if (req.method === "POST" && !number) {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          json(res, 200, await gh.createIssue(session.githubToken, session.repository, body));
          return;
        }
        if (req.method === "PATCH" && number) {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          json(res, 200, await gh.updateIssue(session.githubToken, session.repository, number, body));
          return;
        }
        if (req.method === "GET" && number) {
          json(res, 200, await gh.getIssue(session.githubToken, session.repository, number));
          return;
        }
      }

      json(res, 404, { message: "Unknown GitHub proxy route." });
    } catch (error) {
      json(res, error.status || 400, { message: error.message || "GitHub request failed." });
    }
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

  // The token gate covers API routes only. Public-by-design paths (/health,
  // /auth/*, /github/*, the webhook) are handled above; everything else falls
  // through to the static web build, which a browser must be able to load
  // before it has any credentials.
  if (isApiPath(url.pathname) && !isAuthorizedRequest(req)) {
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

  // Read a linked Notion page without leaving the decision. The client sends
  // the URL it was given; the token stays here.
  if (url.pathname === "/sources/notion" && req.method === "GET") {
    if (!notion.configured) {
      json(res, 503, { message: "Notion is not connected on this relay." });
      return;
    }
    const pageID =
      url.searchParams.get("pageID") || notionPageIdFromUrl(url.searchParams.get("url"));
    if (!pageID) {
      json(res, 400, { message: "Not a Notion page URL." });
      return;
    }

    const page = await notion.page(pageID);
    if (!page) {
      json(res, 404, { message: "That page isn't shared with the integration." });
      return;
    }
    json(res, 200, { ...page, excerpt: await notion.excerpt(pageID) });
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
      const userId = body.userId || sessionStore.fromRequest(req)?.session.userId;

      const isWeb = body.platform === "web";
      const registered = isWeb
        ? pushRegistry.registerWeb(userId, body.subscription)
        : pushRegistry.register(userId, body.deviceToken);

      if (!registered) {
        json(res, 400, {
          message: isWeb
            ? "Valid userId and push subscription are required."
            : "Valid userId and deviceToken are required.",
        });
        return;
      }

      persistPush();
      json(res, 200, {
        registered: true,
        pushEnabled: isWeb ? webPush.configured : apns.configured,
      });
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

  // Server-side decision resolution: one implementation for every client.
  // Native clients may still resolve locally and report via card_updated;
  // both paths converge on the same store and broadcasts.
  if (url.pathname === "/cards/decide" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const session = sessionStore.fromRequest(req)?.session;
      const actorUserID = body.actorUserID || session?.userId;
      const { cardId, action, note, delegateToUserID, priority } = body;

      if (!actorUserID || !cardId || !DECISION_ACTIONS.includes(action)) {
        json(res, 400, { message: "actorUserID, cardId and a valid action are required." });
        return;
      }

      const store = getStore(ORG_ID);
      const card = findCard(store, actorUserID, cardId);
      if (!card) {
        json(res, 404, { message: "Card not found for this user." });
        return;
      }
      if (card.status !== "pending") {
        json(res, 409, { message: "This card has already been decided." });
        return;
      }
      if (action === "delegate" && !orgStore.findUser(delegateToUserID)) {
        json(res, 400, { message: "delegateToUserID must be an org member." });
        return;
      }

      if (action === "priority") {
        if (!["low", "medium", "high", "urgent"].includes(priority)) {
          json(res, 400, { message: "priority must be low, medium, high or urgent." });
          return;
        }
        card.priority = priority;
        persister.schedule(orgStores);
        broadcast(ORG_ID, "card_updated", { card });
        json(res, 200, { card });
        return;
      }

      const { followUps } = applyDecision({
        card,
        action,
        note,
        actorUserID,
        delegateToUserID,
      });

      // Sync GitHub when this session can: the browser never holds a token,
      // so the relay does it with the session's.
      if (session?.githubToken && session.repository && needsGitHubSync(action, card)) {
        try {
          const synced = card.githubIssueNumber
            ? await gh.updateIssue(session.githubToken, session.repository, card.githubIssueNumber, {
                title: issueTitle(card),
                body: issueBody(card),
                state: githubStateFor(card.status),
              })
            : await gh.createIssue(session.githubToken, session.repository, {
                title: issueTitle(card),
                body: issueBody(card),
                labels: card.labels,
              });
          card.githubIssueNumber = synced.number;
          card.githubIssueURL = synced.url;
          card.githubRepository = session.repository;
          for (const followUp of followUps) {
            followUp.githubIssueNumber = synced.number;
            followUp.githubIssueURL = synced.url;
            followUp.githubRepository = session.repository;
          }
        } catch (error) {
          // A GitHub outage must not lose the decision: keep it, report it.
          console.warn("GitHub sync failed during decision:", error.message);
        }
      }

      memoryStore.record(actorUserID, {
        action: action === "acknowledge" ? "approve" : action,
        type: card.type,
        priority: card.priority,
        senderUserID: card.senderUserID,
        title: String(card.title || "").slice(0, 60),
        at: new Date().toISOString(),
      });
      persistMemory();

      persister.schedule(orgStores);
      broadcast(ORG_ID, "card_updated", { card });
      for (const followUp of followUps) {
        await deliverCard(ORG_ID, followUp);
      }

      json(res, 200, { card, followUps: followUps.length });
    } catch (error) {
      json(res, 400, { message: error.message || "Decision failed." });
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

  // Web client: anything unmatched falls through to the static build
  // (SPA routes resolve to index.html). API paths are matched above.
  const staticFile =
    req.method === "GET" || req.method === "HEAD"
      ? resolveStaticFile(WEB_DIST_PATH, url.pathname)
      : null;
  if (staticFile) {
    serveStaticFile(res, staticFile, { method: req.method });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // Keep the upgrade request so join can fall back to cookie auth.
  ws.upgradeReq = req;
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
        if (!isAuthorizedJoin(payload, ws.upgradeReq)) {
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

        // pending → decided transitions feed the recipient's decision memory.
        const previous = (store[card.recipientUserID] || []).find(
          (item) => item.id === card.id
        );
        const action = recordableTransition(previous?.status, card.status);
        if (action) {
          memoryStore.record(card.recipientUserID, {
            action,
            type: card.type,
            priority: card.priority,
            senderUserID: card.senderUserID,
            title: String(card.title || "").slice(0, 60),
            at: new Date().toISOString(),
          });
          persistMemory();
        }

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
      sourceMessageID: message.id,
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
  sessionPersister.flushNow(new Map([["sessions", sessionStore.serialize().sessions]]));
  digestPersister.flushNow(new Map([["lastRunByUser", digestState]]));
  memoryPersister.flushNow(new Map([["entries", memoryStore.serialize().entries]]));
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
  console.log(apns.configured ? "Push: APNs configured" : "Push: APNs off (set APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)");
  console.log(webPush.configured ? "Push: Web Push configured" : "Push: Web Push off (set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)");
  console.log(
    notion.configured
      ? "Notion: connected (cards resolve linked pages and find related ones)"
      : "Notion: off (set NOTION_TOKEN — cards keep link-only provenance)"
  );
  console.log(
    existsSync(WEB_DIST_PATH) ? `Web client: serving ${WEB_DIST_PATH}` : "Web client: not built (run web build)"
  );
  console.log(`Card store: ${STORE_PATH}`);
  if (DEV_AUTH) {
    console.warn("DEV AUTH IS ON: /auth/dev?user=… grants a session with no credentials.");
  }
});
