import { addressHolds, signedQuery } from "./addressSigning.js";
import { getProfile, mayAccessAgent } from "./harness/agents.js";

const MEDIA_ID = /^agent-avatar-[0-9a-f-]{36}$/;
const inaccessible = () => new Response("not found", { status: 404, headers: {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} });

const mediaIdFrom = (avatarUrl) => {
  const match = /\/agents\/avatar\/(agent-avatar-[0-9a-f-]{36})$/.exec(String(avatarUrl || ""));
  return match && MEDIA_ID.test(match[1]) ? match[1] : null;
};

async function currentAccess(db, orgId, agentId, login) {
  const [profile, access, member] = await Promise.all([
    getProfile(db, orgId, agentId),
    db.prepare("SELECT version FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2").bind(orgId, agentId).first(),
    db.prepare(\`SELECT u.github_id, m.created_at FROM users u JOIN memberships m
      ON m.user_github_id=u.github_id AND m.org_id=?1 AND m.role!='guest'
      WHERE u.login=?2\`).bind(orgId, login).first(),
  ]);
  return { profile, version: Number(access?.version || 0), member };
}

const restricted = (agent, profile) => agent.scope === "personal" || profile.access !== "everyone";
const revision = (current) => \`\${current.profile.updatedAt || ""}:\${current.version}:\${current.member?.created_at || ""}\`;
const signedId = (mediaId, agentId, viewerId, rev) => \`\${mediaId}\\n\${agentId}\\n\${viewerId}\\n\${rev}\`;

/// The same avatar address is public and cacheable for team-wide agents.
/// A restricted agent receives a short-lived, viewer-bound address whose ACL
/// and membership revisions are checked again for every image request.
export async function clientAgentAvatarUrl(env, orgId, agent, login) {
  const mediaId = mediaIdFrom(agent?.avatarUrl);
  if (!mediaId) return null;
  const current = await currentAccess(env.DB, orgId, agent.id, login);
  if (!restricted(agent, current.profile)) {
    const url = new URL(agent.avatarUrl);
    url.search = \`revision=\${encodeURIComponent(revision(current))}\`;
    return url.toString();
  }
  if (!current.member || !await mayAccessAgent(env.DB, orgId, agent, login)) return null;
  const viewerId = String(current.member.github_id);
  const signed = await signedQuery(env, "a1", orgId, signedId(mediaId, agent.id, viewerId, revision(current)));
  if (!signed) return null;
  const url = new URL(agent.avatarUrl);
  url.search = \`agent=\${encodeURIComponent(agent.id)}&viewer=\${encodeURIComponent(viewerId)}&\${signed.query}\`;
  return url.toString();
}

/// Agent avatar bytes are intentionally independent of profile content. The
/// route returns the same opaque 404 for a missing avatar, stale link, revoked
/// access, removed membership, or a URL signed for another person.
export async function authorizeAgentAvatar(env, url, mediaId) {
  const agentId = url.searchParams.get("agent") || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return { response: inaccessible() };
  const agent = await env.DB.prepare(\`SELECT id,org_id,scope,owner_login,avatar_url FROM custom_agents
    WHERE id=?1 AND deleted_at IS NULL AND avatar_url LIKE ?2\`).bind(agentId, \`%/agents/avatar/\${mediaId}\`).first();
  if (!agent || mediaIdFrom(agent.avatar_url) !== mediaId) return { response: inaccessible() };
  const model = { id: agent.id, scope: agent.scope, ownerLogin: agent.owner_login };
  const viewerId = url.searchParams.get("viewer") || "";
  if (!/^[0-9]{1,24}$/.test(viewerId)) {
    // Legacy/public URLs have no viewer parameter; they remain public only
    // while the current Agent policy is public.
    const current = await getProfile(env.DB, agent.org_id, agent.id);
    return restricted(model, current) ? { response: inaccessible() } : { public: true, agent };
  }
  const viewer = await env.DB.prepare("SELECT login FROM users WHERE github_id=?1").bind(viewerId).first();
  const login = viewer?.login || "";
  const current = await currentAccess(env.DB, agent.org_id, agent.id, login);
  if (!restricted(model, current.profile)) return { public: true, agent };
  if (!login || !current.member || String(current.member.github_id) !== viewerId) return { response: inaccessible() };
  const boundId = signedId(mediaId, agent.id, viewerId, revision(current));
  if (!await addressHolds(env, url, "a1", agent.org_id, boundId)) return { response: inaccessible() };
  if (!await mayAccessAgent(env.DB, agent.org_id, model, login)) return { response: inaccessible() };
  return { public: false, agent };
}

export { inaccessible as inaccessibleAgentAvatar };
