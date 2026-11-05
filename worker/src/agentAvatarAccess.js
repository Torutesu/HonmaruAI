import { addressHolds, signedQuery } from "./addressSigning.js";
import { getProfile, mayAccessAgent } from "./harness/agents.js";
import { currentOrigin } from "./requestContext.js";

const MEDIA_ID = /^agent-avatar-[0-9a-f-]{36}$/;
const inaccessible = () => new Response("not found", { status: 404, headers: {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} });

function trustedAvatarUrl(env, value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  const localHttp = url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== "https:" && !localHttp) return null;
  if (url.username || url.password) return null;
  const allowed = new Set();
  const addOrigin = (raw) => {
    try {
      const candidate = new URL(String(raw || ""));
      const candidateLocal = candidate.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(candidate.hostname);
      if (candidate.protocol === "https:" || candidateLocal) allowed.add(candidate.origin);
    } catch { /* invalid config fails closed */ }
  };
  addOrigin(currentOrigin());
  addOrigin(env?.APP_WEB_URL);
  addOrigin(env?.API_ORIGIN);
  for (const raw of String(env?.AGENT_AVATAR_ORIGINS || "").split(",")) addOrigin(raw.trim());
  return allowed.has(url.origin) ? url : null;
}

const mediaIdFrom = (avatarUrl) => {
  let url;
  try { url = new URL(String(avatarUrl || "")); } catch { return null; }
  const match = /^\/agents\/avatar\/(agent-avatar-[0-9a-f-]{36})$/.exec(url.pathname);
  return match && MEDIA_ID.test(match[1]) ? match[1] : null;
};

async function currentAccess(db, orgId, agentId, login) {
  const [profile, access, member] = await Promise.all([
    getProfile(db, orgId, agentId),
    db.prepare("SELECT version FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2").bind(orgId, agentId).first(),
    db.prepare("SELECT u.github_id, m.created_at FROM users u JOIN memberships m ON m.user_github_id=u.github_id AND m.org_id=?1 AND m.role!='guest' WHERE u.login=?2").bind(orgId, login).first(),
  ]);
  return { profile, version: Number(access?.version || 0), member };
}

const restricted = (agent, profile) => agent.scope === "personal" || profile.access !== "everyone";
const revision = (current) => String(current.profile.updatedAt || "") + ":" + current.version + ":" + String(current.member?.created_at || "");
const signedId = (mediaId, agentId, viewerId, rev) => mediaId + "\n" + agentId + "\n" + viewerId + "\n" + rev;

async function agentsForMedia(db, mediaId, agentId = "") {
  const query = agentId
    ? db.prepare("SELECT id,org_id,scope,owner_login,avatar_url FROM custom_agents WHERE id=?1 AND deleted_at IS NULL AND avatar_url LIKE ?2").bind(agentId, "%/agents/avatar/" + mediaId)
    : db.prepare("SELECT id,org_id,scope,owner_login,avatar_url FROM custom_agents WHERE deleted_at IS NULL AND avatar_url LIKE ?1").bind("%/agents/avatar/" + mediaId);
  const { results } = await query.all();
  return (results || []).filter((row) => mediaIdFrom(row.avatar_url) === mediaId);
}

export async function clientAgentAvatarUrl(env, orgId, agent, login) {
  const safeUrl = trustedAvatarUrl(env, agent?.avatarUrl);
  const mediaId = mediaIdFrom(safeUrl?.toString());
  if (!safeUrl || !mediaId) return null;
  const current = await currentAccess(env.DB, orgId, agent.id, login);
  const url = safeUrl;
  url.search = "";
  url.hash = "";
  url.searchParams.set("agent", agent.id);
  if (!restricted(agent, current.profile)) {
    url.searchParams.set("revision", revision(current));
    return url.toString();
  }
  if (!current.member || !await mayAccessAgent(env.DB, orgId, agent, login)) return null;
  const viewerId = String(current.member.github_id);
  const signed = await signedQuery(env, "a1", orgId, signedId(mediaId, agent.id, viewerId, revision(current)));
  if (!signed) return null;
  url.searchParams.set("viewer", viewerId);
  for (const [key, value] of new URLSearchParams(signed.query)) url.searchParams.set(key, value);
  return url.toString();
}

export async function authorizeAgentAvatar(env, url, mediaId) {
  const agentId = url.searchParams.get("agent") || "";
  if (agentId && !/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return { response: inaccessible() };
  const agents = await agentsForMedia(env.DB, mediaId, agentId);
  if (!agents.length) return { response: inaccessible() };

  const viewerId = url.searchParams.get("viewer") || "";
  if (!viewerId) {
    for (const agent of agents) {
      const profile = await getProfile(env.DB, agent.org_id, agent.id);
      if (restricted(agent, profile)) return { response: inaccessible() };
    }
    return { public: true };
  }

  if (!agentId || agents.length !== 1 || !/^[0-9]{1,24}$/.test(viewerId)) return { response: inaccessible() };
  const agent = agents[0];
  const model = { id: agent.id, scope: agent.scope, ownerLogin: agent.owner_login };
  const viewer = await env.DB.prepare("SELECT login FROM users WHERE github_id=?1").bind(viewerId).first();
  const login = viewer?.login || "";
  const current = await currentAccess(env.DB, agent.org_id, agent.id, login);
  if (!restricted(model, current.profile)) return { public: true };
  if (!login || !current.member || String(current.member.github_id) !== viewerId) return { response: inaccessible() };
  const boundId = signedId(mediaId, agent.id, viewerId, revision(current));
  if (!await addressHolds(env, url, "a1", agent.org_id, boundId)) return { response: inaccessible() };
  if (!await mayAccessAgent(env.DB, agent.org_id, model, login)) return { response: inaccessible() };
  return { public: false };
}

export { inaccessible as inaccessibleAgentAvatar };
