import { sha256Hex } from "./auth.js";
import { saveCard, getCard, getUserByGithubId, isMember } from "./db.js";
import { listMembers } from "./team.js";
import { searchDecisions } from "./insights.js";
import { appendCardEvent } from "./events.js";
import { announceCards } from "./announce.js";
import { emitCard } from "./webhooks.js";
import { localizeForRecipient } from "./localize.js";
import { notifyCard, anyChannelConfigured } from "./notify.js";
import { enforceSubject } from "./ratelimit.js";
import { listMemories } from "./memory.js";
import { safe } from "./log.js";

// Any agent can ask a person for a decision.
//
// An assistant that lives in a chat app is one more agent doing work. The
// work that is not an agent's to do — approve the spend, pick the design,
// sign off the release — has to reach a person, and today it reaches them
// as a message in a channel, lost among the others. This is the other
// direction: Claude Code, Cursor, an in-house bot call `request_decision`
// over MCP, the decision lands in the right person's feed as a card, and
// the agent reads the answer back with `get_decision`. The team's playbook
// is readable too, so an agent can follow the rules a team already set
// before it asks.
//
// Transport: MCP's Streamable HTTP, answered as plain JSON (no stream — no
// tool here takes long enough to need one). Auth: a personal access token,
// one per agent, scoped to one workspace, stored only as its hash.

export const MCP_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_TOKENS_PER_PERSON = 10;
const TOKEN_PREFIX = "hm_";

// ---- Tokens ----------------------------------------------------------------

/// What a token may do. `read` reads decisions, people and the playbook;
/// `write` asks for decisions; `audit:read` reads the audit log (and only
/// an admin's token can use it). A token made before scopes had read and
/// write, and keeps them.
export const SCOPES = ["read", "write", "audit:read"];
const LEGACY_SCOPES = ["read", "write"];
const TOOL_SCOPE = { request_decision: "write" };

export function cleanScopes(input) {
  if (!Array.isArray(input)) return LEGACY_SCOPES;
  const out = SCOPES.filter((s) => input.includes(s));
  return out.length ? out : ["read"];
}

export function parseScopes(raw) {
  if (!raw) return LEGACY_SCOPES;
  try { return cleanScopes(JSON.parse(raw)); } catch { return LEGACY_SCOPES; }
}

export function hasScope(scopes, scope) {
  return Array.isArray(scopes) && scopes.includes(scope);
}

const scopeOfTool = (name) => TOOL_SCOPE[name] || "read";

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createApiToken(db, { orgId, githubId, name, scopes }) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Agent";
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE github_id = ?1 AND org_id = ?2")
    .bind(String(githubId), orgId)
    .first();
  if ((count?.n || 0) >= MAX_TOKENS_PER_PERSON) return { error: `You have ${MAX_TOKENS_PER_PERSON} agent tokens already. Revoke one first.` };
  const token = randomToken();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const granted = cleanScopes(scopes);
  await db
    .prepare(
      `INSERT INTO api_tokens (id, token_hash, org_id, github_id, name, prefix, created_at, scopes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(id, await sha256Hex(token), orgId, String(githubId), clean, token.slice(0, 10), now, JSON.stringify(granted))
    .run();
  return { token, id, name: clean, prefix: token.slice(0, 10), createdAt: now, scopes: granted };
}

export async function listApiTokens(db, { orgId, githubId }) {
  const { results } = await db
    .prepare(
      `SELECT id, name, prefix, created_at, last_used_at, scopes FROM api_tokens
        WHERE github_id = ?1 AND org_id = ?2 ORDER BY created_at ASC`
    )
    .bind(String(githubId), orgId)
    .all();
  return (results || []).map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at || null, scopes: parseScopes(r.scopes) }));
}

/// Revoke one of your own. Returns what it was, for the audit log, or null.
export async function revokeApiToken(db, { orgId, githubId, id }) {
  const row = await db
    .prepare("SELECT name, prefix FROM api_tokens WHERE id = ?1 AND github_id = ?2 AND org_id = ?3")
    .bind(id, String(githubId), orgId)
    .first();
  if (!row) return null;
  await db.prepare("DELETE FROM api_tokens WHERE id = ?1").bind(id).run();
  return { name: row.name, prefix: row.prefix };
}

/// Who a bearer token speaks for, or null. A token outlives nothing: its
/// owner must still be in the workspace it was made for.
export async function resolveApiToken(db, header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || "").trim());
  if (!match || !match[1].startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .prepare("SELECT id, org_id, github_id, name, last_used_at, scopes FROM api_tokens WHERE token_hash = ?1")
    .bind(await sha256Hex(match[1]))
    .first();
  if (!row) return null;
  if (!(await isMember(db, row.org_id, row.github_id))) return null;
  const user = await getUserByGithubId(db, row.github_id);
  if (!user?.login) return null;
  // Written at most every five minutes: "last used" is for a person
  // deciding which token to revoke, not an audit log.
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 300000) {
    await db.prepare("UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1").bind(row.id, new Date(now).toISOString()).run().catch(() => {});
  }
  return { tokenId: row.id, agentName: row.name, orgId: row.org_id, githubId: String(row.github_id), login: user.login, name: user.name || user.login, scopes: parseScopes(row.scopes) };
}

// ---- Tools -------------------------------------------------------------------

const PRIORITIES = ["low", "medium", "high", "urgent"];
const TYPES = ["approval", "task", "delegation", "notification"];

export const TOOLS = [
  {
    name: "request_decision",
    title: "Ask a person for a decision",
    description: "Put a decision in a teammate's Honmaru feed and get a card id back. Use it for anything that is a person's call: approving a spend, choosing between options, signing off a release, answering a question only they can. Then poll get_decision with the card id. Write the title as the question to decide; put what they need to decide in summary and context. Check get_playbook first: the team may already have a rule.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Who decides: a teammate's name, as list_members shows it. Leave out to ask the token's owner." },
        title: { type: "string", description: "The decision, as one line (under 120 characters)." },
        summary: { type: "string", description: "What is being asked and what you recommend, in two or three sentences." },
        context: { type: "string", description: "Anything else they need: numbers, links, what happens either way." },
        priority: { type: "string", enum: PRIORITIES, description: "How soon. Default medium." },
        type: { type: "string", enum: TYPES, description: "approval (yes/no, the default), task, delegation, or notification (FYI)." },
      },
      required: ["title"],
    },
  },
  {
    name: "get_decision",
    title: "Read a decision",
    description: "The status of a card you asked about with request_decision: pending, approved, rejected, revised, delegated or completed — and the decider's note when there is one.",
    inputSchema: { type: "object", properties: { cardId: { type: "string" } }, required: ["cardId"] },
  },
  {
    name: "list_pending",
    title: "What is waiting",
    description: "Decisions still open: the ones waiting on the token's owner (\"mine\", the default) or the ones the owner is waiting on from others (\"sent\").",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["mine", "sent"] } } },
  },
  {
    name: "search_decisions",
    title: "Search past decisions",
    description: "The team's past decisions matching a few keywords, newest first, with who decided and their note. Use it before asking again for something already decided.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "list_members",
    title: "Who is on the team",
    description: "The workspace's members: name and what they do. Pass a name to request_decision's `to`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_playbook",
    title: "The team's rules",
    description: "Rules this team has decided or written down (thresholds, owners, standing preferences). Follow them; they are how this team decides.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(typeof value === "string" ? {} : { structuredContent: value }) };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function clip(value, n) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function decisionView(card) {
  return {
    cardId: card.id,
    title: card.title,
    status: card.status,
    recipient: card.recipientName || card.recipientUserID,
    ...(card.decision ? {
      decision: {
        action: card.decision.action,
        note: card.decision.note || card.decision.replyText || null,
        decidedAt: card.decision.decidedAt || null,
        delegatedTo: card.decision.delegatedTo || null,
      },
    } : {}),
    createdAt: card.createdAt,
  };
}

/// A name, a login, an alias or a handle, to a member. Case and spaces do
/// not matter; a name that fits more than one person fits nobody.
export function findMember(members, who) {
  const want = String(who || "").trim().toLowerCase();
  if (!want) return null;
  const exact = members.filter((m) =>
    [m.handle, m.name, m.login, m.ref, `member:${m.ref}`, ...(m.aliases || [])].some((v) => String(v || "").toLowerCase() === want));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = members.filter((m) => String(m.name || "").toLowerCase().split(/\s+/).includes(want));
  return partial.length === 1 ? partial[0] : null;
}

async function callTool(env, agent, name, args, request, ctx = null) {
  const db = env.DB;
  switch (name) {
    case "request_decision": {
      // Per person, not per token: a second token — or a revoked one made
      // again — must not buy a looping agent another thirty cards an hour
      // in somebody's feed.
      const limited = await enforceSubject(env, "mcp/request_decision", `p:${agent.orgId}:${agent.githubId}`);
      if (limited) return toolError("Too many decisions requested this hour. A person can only take so many; try again later.");
      const title = clip(args.title, 120);
      if (!title) return toolError("title is required.");
      const members = await listMembers(db, agent.orgId, agent.githubId);
      const recipient = args.to ? findMember(members, args.to) : members.find((m) => m.mine);
      if (!recipient) {
        return toolError(`Nobody on this team matches "${clip(args.to, 60)}". Members: ${members.map((m) => m.name).join(", ")}.`);
      }
      const priority = PRIORITIES.includes(args.priority) ? args.priority : "medium";
      const type = TYPES.includes(args.type) ? args.type : "approval";
      const now = new Date().toISOString();
      const card = {
        id: crypto.randomUUID(),
        recipientUserID: recipient.login,
        recipientName: recipient.name,
        senderUserID: agent.login,
        type,
        format: type === "notification" ? "fyi" : "approve",
        title,
        summary: clip(args.summary, 600),
        context: clip(args.context, 3000),
        priority,
        status: "pending",
        createdAt: now,
        sourceApp: "Agent",
        sourceDetail: agent.agentName,
        agentRoute: `${agent.agentName} → ${recipient.name}`,
        routingReason: recipient.mine ? "Asked of you" : `Asked by ${agent.agentName} on behalf of ${agent.name}`,
        requestedBy: { login: agent.login, name: `${agent.agentName} (${agent.name})` },
      };
      await saveCard(db, agent.orgId, card);
      await appendCardEvent(db, agent.orgId, { cardId: card.id, type: "created", actorUserId: agent.login, note: `agent: ${agent.agentName}`, snapshot: card });
      // An agent writes in whatever language it was prompted in; the person
      // deciding reads theirs.
      const shown = await localizeForRecipient(env, agent.orgId, card, { payerGithubId: agent.githubId });
      await announceCards(env, agent.orgId, [shown]);
      // Somebody's webhook is somebody else's server: the agent has its
      // answer without waiting on it.
      const emitted = emitCard(env, agent.orgId, card, "card.created").catch(() => 0);
      if (ctx?.waitUntil) ctx.waitUntil(emitted);
      else await emitted;
      if (anyChannelConfigured(env)) {
        await notifyCard(env, { card: shown, kind: "created", excludeLogin: null, orgId: agent.orgId, payerGithubId: agent.githubId }).catch((err) => console.error("mcp notify failed", safe(err?.message)));
      }
      const link = env.APP_WEB_URL ? `${String(env.APP_WEB_URL).replace(/\/$/, "")}/#/feed/${encodeURIComponent(card.id)}` : null;
      return text({ cardId: card.id, status: "pending", recipient: recipient.name, ...(link ? { url: link } : {}), next: "Call get_decision with this cardId to read the answer." });
    }
    case "get_decision": {
      const cardId = clip(args.cardId, 200);
      const card = cardId ? await getCard(db, agent.orgId, cardId) : null;
      // Only the cards this person is on: an agent is its owner, not the team.
      if (!card || (card.senderUserID !== agent.login && card.recipientUserID !== agent.login)) {
        return toolError("No such decision for this token.");
      }
      return text(decisionView(card));
    }
    case "list_pending": {
      const column = args.direction === "sent" ? "sender_user_id" : "recipient_user_id";
      const { results } = await db
        .prepare(`SELECT data FROM cards WHERE org_id = ?1 AND ${column} = ?2 AND status = 'pending' ORDER BY created_at DESC LIMIT 25`)
        .bind(agent.orgId, agent.login)
        .all();
      const cards = (results || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
      return text({ decisions: cards.map((c) => ({ ...decisionView(c), priority: c.priority, summary: clip(c.summary, 200) })) });
    }
    case "search_decisions": {
      const query = clip(args.query, 200);
      if (!query) return toolError("query is required.");
      const hits = await searchDecisions(db, agent.orgId, query, { limit: 10 });
      return text({ decisions: hits.map((d) => ({ title: d.title, status: d.status, decidedAt: d.decidedAt, decidedBy: d.recipient, note: d.note || null, business: d.business || null })) });
    }
    case "list_members": {
      const members = await listMembers(db, agent.orgId, agent.githubId);
      return text({ members: members.map((m) => ({ name: m.name, title: m.title || m.role, you: m.mine })) });
    }
    case "get_playbook": {
      const rules = await listMemories(db, agent.orgId, { limit: 50 });
      return text({ rules: rules.map((m) => m.text) });
    }
    default:
      return null;
  }
}

// ---- JSON-RPC ------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(env, agent, msg, request, ctx = null) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "honmaru", title: "Honmaru AI", version: "1.0.0" },
        instructions: `You are connected to ${agent.name}'s team on Honmaru AI, where people make decisions. When something is a person's call, do not guess and do not ask in chat: call request_decision and wait for the answer with get_decision. Read get_playbook first; follow the team's rules.`,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(msg.id, {});
    case "tools/list":
      // Only what this token may call.
      return rpcResult(msg.id, { tools: TOOLS.filter((t) => hasScope(agent.scopes, scopeOfTool(t.name))) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      if (TOOLS.some((t) => t.name === name) && !hasScope(agent.scopes, scopeOfTool(name))) {
        return rpcResult(msg.id, toolError(`This key does not have the ${scopeOfTool(name)} scope. Make a key with it under Studio → API.`));
      }
      try {
        const out = await callTool(env, agent, name, args, request, ctx);
        if (!out) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        return rpcResult(msg.id, out);
      } catch (err) {
        console.error("mcp tool failed", name, safe(err?.message));
        return rpcResult(msg.id, toolError("That did not work on our side. Try again."));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const MCP_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "mcp-session-id",
};

/// The whole endpoint. POST only; a GET (the server-to-client stream) is not
/// offered, which the transport allows.
export async function handleMcp(request, env, ctx = null) {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response(null, { status: 405, headers: { allow: "POST", ...MCP_HEADERS } });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const agent = await resolveApiToken(env.DB, request.headers.get("authorization"));
  if (!agent) {
    return new Response(JSON.stringify(rpcError(null, -32001, "A Honmaru access token is required: Authorization: Bearer hm_…  (You → Tools → Connect an agent).")), {
      status: 401,
      headers: { ...MCP_HEADERS, "www-authenticate": 'Bearer realm="honmaru"' },
    });
  }
  const limited = await enforceSubject(env, "mcp", `t:${agent.tokenId}`);
  if (limited) return limited;
  const body = await request.json().catch(() => undefined);
  if (body === undefined) {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: MCP_HEADERS });
  }
  const messages = Array.isArray(body) ? body.slice(0, 20) : [body];
  const replies = [];
  for (const msg of messages) {
    const reply = await handleMessage(env, agent, msg, request, ctx);
    if (reply) replies.push(reply);
  }
  // Only notifications and responses: nothing to answer.
  if (!replies.length) return new Response(null, { status: 202, headers: MCP_HEADERS });
  return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200, headers: MCP_HEADERS });
}

