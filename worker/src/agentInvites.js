import { getSession, isMember } from "./db.js";
import { enforce } from "./ratelimit.js";
import { sha256Hex, channelsOf } from "./auth.js";
import { createApiToken } from "./mcp.js";
import { teamName } from "./orgs.js";
import { introduce } from "./welcome.js";

// Bringing an agent into a workspace with a link, the way a person is
// brought in with one: a member makes it, hands it to the agent, and the
// agent opens it. The link works once and for fifteen minutes; opening it
// is what mints the agent its MCP token, which acts for the member who made
// the link — so what the agent may do is exactly what they may.

export const AGENT_LINK_MINUTES = 15;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS },
  });
}

function newCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// POST /agents/invite · GET|POST /agents/join/:code
export async function handleAgentInvites(request, env, url) {
  if (url.pathname === "/agents/invite" && request.method === "POST") {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const session = await getSession(env.DB, request.headers.get("x-session-token"));
    if (!session) return json({ message: "Please sign in." }, 401);
    const body = await request.json().catch(() => ({}));
    if (!body.orgId) return json({ message: "orgId is required" }, 400);
    if (!(await isMember(env.DB, body.orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
    const code = newCode();
    const now = new Date();
    const expires = new Date(now.getTime() + AGENT_LINK_MINUTES * 60_000);
    const channels = await channelsOf(env.DB, body.orgId, body.channels);
    await env.DB.prepare(
      "INSERT INTO agent_invites (code_hash, org_id, created_by, channels, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(await sha256Hex(code), body.orgId, String(session.github_id), channels.length ? JSON.stringify(channels) : null, now.toISOString(), expires.toISOString()).run();
    return json({ url: `${url.origin}/agents/join/${code}`, expiresAt: expires.toISOString(), channels }, 201);
  }

  const join = url.pathname.match(/^\/agents\/join\/([0-9a-f]{48})$/);
  if (join && (request.method === "GET" || request.method === "POST")) {
    const limited = await enforce(env, request, "invites/peek");
    if (limited) return limited;
    const hash = await sha256Hex(join[1]);
    const now = new Date().toISOString();
    // Spent in the same statement that checks it, so two agents opening one
    // link at once cannot both get in.
    const claimed = await env.DB.prepare(
      "UPDATE agent_invites SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1"
    ).bind(now, hash).run();
    if (!(claimed?.meta?.changes > 0)) {
      return json({ message: "This link has been used or has expired. Ask for a new one." }, 410);
    }
    const row = await env.DB.prepare("SELECT org_id, created_by, channels FROM agent_invites WHERE code_hash = ?1").bind(hash).first();
    const asked = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const name = String(asked.name || url.searchParams.get("name") || "Agent").replace(/\s+/g, " ").trim().slice(0, 60) || "Agent";
    const minted = await createApiToken(env.DB, { orgId: row.org_id, githubId: row.created_by, name });
    if (minted.error) {
      // Nothing was given: the link may be tried again once there is room.
      await env.DB.prepare("UPDATE agent_invites SET used_at = NULL WHERE code_hash = ?1").bind(hash).run();
      return json({ message: minted.error }, 409);
    }
    if (row.channels) {
      await introduce(env, { orgId: row.org_id, channels: JSON.parse(row.channels), agentName: minted.name, invitedBy: row.created_by })
        .catch((err) => console.error("agent welcome failed", err?.message || err));
    }
    const endpoint = `${url.origin}/mcp`;
    const claude = `claude mcp add --transport http honmaru ${endpoint} --header "Authorization: Bearer ${minted.token}"`;
    return json({
      workspace: await teamName(env.DB, row.org_id).catch(() => null),
      agent: minted.name,
      endpoint,
      token: minted.token,
      instructions: `You were added to a Honmaru workspace. Connect to its MCP server at ${endpoint} with the header "Authorization: Bearer <token>". In Claude Code: ${claude}. The token is shown this once.`,
      claudeCode: claude,
      mcpServers: { honmaru: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${minted.token}` } } },
    }, 201);
  }
  return null;
}
