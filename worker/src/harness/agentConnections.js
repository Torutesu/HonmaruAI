import { connectedSources } from '../context.js';
import { mayAccessAgent } from './agents.js';

export const AGENT_CONNECTION_SOURCES = ['notion', 'github'];

async function grantsFor(db, orgId, agentId, githubId) {
  const { results = [] } = await db.prepare(`SELECT g.source FROM hx_agent_source_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id
      AND m.created_at=g.membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE g.org_id=?1 AND g.agent_id=?2 AND g.user_github_id=?3`)
    .bind(orgId, agentId, String(githubId)).all();
  return new Set(results.map(row => row.source));
}

async function currentAgentAccess(db, orgId, agentId, githubId) {
  const row = await db.prepare(`SELECT a.id,a.scope,a.owner_login AS ownerLogin,u.login FROM custom_agents a
    JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?3
      AND LOWER(COALESCE(m.role,'guest'))!='guest'
    JOIN users u ON u.github_id=m.user_github_id
    WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL`)
    .bind(orgId, agentId, String(githubId)).first();
  return Boolean(row && await mayAccessAgent(db, orgId, row, row.login));
}

async function activeNotionShare(db, orgId, agentId) {
  return db.prepare(`SELECT s.owner_github_id FROM hx_agent_source_shares s
    JOIN memberships m ON m.org_id=s.org_id AND m.user_github_id=s.owner_github_id
      AND m.created_at=s.owner_membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    JOIN custom_agents a ON a.org_id=s.org_id AND a.id=s.agent_id AND a.deleted_at IS NULL
    WHERE s.org_id=?1 AND s.agent_id=?2 AND s.source='notion'`)
    .bind(orgId, agentId).first();
}

/// Resolve the connection identity an authorized caller may use for this
/// Agent. A caller's own explicit grant takes precedence; otherwise Notion
/// may use its owner's explicitly shared connection for this Agent.
export async function agentSourceProvider(env, { orgId, agentId, session, source }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || !session?.github_id || !agentId) return null;
  const githubId = String(session.github_id);
  if (!await currentAgentAccess(env.DB, orgId, agentId, githubId).catch(() => false)) return null;
  const [available, grants] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, githubId).catch(() => new Set()),
  ]);
  if (available[source] === true && grants.has(source)) return githubId;
  if (source !== 'notion') return null;
  const share = await activeNotionShare(env.DB, orgId, agentId).catch(() => null);
  if (!share?.owner_github_id) return null;
  const owner = String(share.owner_github_id);
  const ownerAvailable = await connectedSources(env, { github_id: owner }, orgId).catch(() => ({}));
  return ownerAvailable.notion === true ? owner : null;
}

export async function agentSourceConnections(env, { orgId, agentId, session }) {
  if (!session?.github_id || !orgId || !agentId) return { connections: [] };
  const githubId = String(session.github_id);
  const [available, grants, share, canAccessAgent] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, githubId).catch(() => new Set()),
    activeNotionShare(env.DB, orgId, agentId).catch(() => null),
    currentAgentAccess(env.DB, orgId, agentId, githubId).catch(() => false),
  ]);
  const shareAvailable = share && canAccessAgent
    ? (await connectedSources(env, { github_id: String(share.owner_github_id) }, orgId).catch(() => ({}))).notion === true
    : false;
  const shareEnabled = Boolean(share && String(share.owner_github_id) === githubId);
  return {
    connections: AGENT_CONNECTION_SOURCES.map(source => ({
      source,
      available: available[source] === true,
      enabled: available[source] === true && grants.has(source),
      canShare: source === 'notion' && available.notion === true && canAccessAgent && (!share || String(share.owner_github_id) === githubId),
      shareEnabled: source === 'notion' && shareEnabled,
      shared: source === 'notion' && Boolean(shareAvailable),
    })),
  };
}

export async function setAgentSourceConnection(env, { orgId, agentId, session, source, enabled }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || typeof enabled !== 'boolean') {
    return { error: 'Choose a supported connection and whether to allow it.' };
  }
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };
  if (enabled) {
    const available = await connectedSources(env, session, orgId).catch(() => ({}));
    if (available[source] !== true) return { error: `Connect ${source === 'notion' ? 'Notion' : 'GitHub'} for this workspace before allowing the Agent to use it.`, status: 409 };
    const result = await env.DB.prepare(`INSERT INTO hx_agent_source_grants
        (org_id,agent_id,user_github_id,membership_since,source,created_at)
      SELECT ?1,?2,?3,m.created_at,?4,?5 FROM memberships m
      JOIN custom_agents a ON a.org_id=m.org_id AND a.id=?2 AND a.deleted_at IS NULL
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND LOWER(COALESCE(m.role,'guest'))!='guest'
      ON CONFLICT(org_id,agent_id,user_github_id,source) DO UPDATE SET
        membership_since=excluded.membership_since,created_at=excluded.created_at`)
      .bind(orgId, agentId, githubId, source, new Date().toISOString()).run();
    if (!result.meta?.changes && !(await grantsFor(env.DB, orgId, agentId, githubId)).has(source)) {
      return { error: 'The workspace or Agent access changed. Reload and try again.', status: 409 };
    }
  } else {
    await env.DB.prepare('DELETE FROM hx_agent_source_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND source=?4')
      .bind(orgId, agentId, githubId, source).run();
  }
  return agentSourceConnections(env, { orgId, agentId, session });
}

/// Only Notion has a well-defined per-member read-only connection identity.
/// GitHub can resolve to a workspace token or a caller OAuth token, so it
/// remains limited to the existing caller-owned grant until those scopes are
/// represented separately.
export async function setAgentSourceShare(env, { orgId, agentId, session, source, enabled }) {
  if (source !== 'notion' || typeof enabled !== 'boolean') {
    return { error: 'Sharing is currently supported for a personal Notion connection only.' };
  }
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };
  if (enabled) {
    if (!await currentAgentAccess(env.DB, orgId, agentId, githubId).catch(() => false)) {
      return { error: 'You need access to this Agent before sharing a connection with it.', status: 403 };
    }
    const available = await connectedSources(env, session, orgId).catch(() => ({}));
    if (available.notion !== true) return { error: 'Connect Notion for this workspace before sharing it.', status: 409 };
    const stamp = new Date().toISOString();
    const member = await env.DB.prepare(`SELECT created_at FROM memberships
      WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'`)
      .bind(orgId, githubId).first();
    if (!member) return { error: 'The workspace membership changed. Reload and try again.', status: 409 };
    await env.DB.prepare(`DELETE FROM hx_agent_source_shares WHERE org_id=?1 AND agent_id=?2 AND source='notion'
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=hx_agent_source_shares.org_id
        AND m.user_github_id=hx_agent_source_shares.owner_github_id
        AND m.created_at=hx_agent_source_shares.owner_membership_since
        AND LOWER(COALESCE(m.role,'guest'))!='guest')`)
      .bind(orgId, agentId).run();
    await env.DB.prepare(`INSERT INTO hx_agent_source_shares
        (org_id,agent_id,owner_github_id,owner_membership_since,source,created_at)
      VALUES (?1,?2,?3,?4,'notion',?5)
      ON CONFLICT(org_id,agent_id,source) DO UPDATE SET
        owner_membership_since=excluded.owner_membership_since,created_at=excluded.created_at
      WHERE owner_github_id=excluded.owner_github_id`)
      .bind(orgId, agentId, githubId, member.created_at, stamp).run();
    const share = await activeNotionShare(env.DB, orgId, agentId).catch(() => null);
    if (String(share?.owner_github_id || '') !== githubId) {
      return { error: 'Another Agent member already shared a Notion connection. Ask them to revoke it first.', status: 409 };
    }
  } else {
    const share = await activeNotionShare(env.DB, orgId, agentId).catch(() => null);
    if (share && String(share.owner_github_id) !== githubId) {
      return { error: 'Only the connection owner can revoke this share.', status: 403 };
    }
    await env.DB.prepare(`DELETE FROM hx_agent_source_shares WHERE org_id=?1 AND agent_id=?2
      AND source='notion' AND owner_github_id=?3`)
      .bind(orgId, agentId, githubId).run();
  }
  return agentSourceConnections(env, { orgId, agentId, session });
}

/// Check the live connection grant immediately before a native source call.
export async function mayUseAgentSource(env, args) {
  return Boolean(await agentSourceProvider(env, args));
}
