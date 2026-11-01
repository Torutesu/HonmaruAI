import { connectedSources } from '../context.js';

export const AGENT_CONNECTION_SOURCES = ['notion', 'github'];

async function grantsFor(db, orgId, agentId, githubId) {
  const { results = [] } = await db.prepare(`SELECT g.source FROM hx_agent_source_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id
      AND m.created_at=g.membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE g.org_id=?1 AND g.agent_id=?2 AND g.user_github_id=?3`)
    .bind(orgId, agentId, String(githubId)).all();
  return new Set(results.map(row => row.source));
}

export async function agentSourceConnections(env, { orgId, agentId, session }) {
  if (!session?.github_id || !orgId || !agentId) return { connections: [] };
  const [available, grants] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, session.github_id).catch(() => new Set()),
  ]);
  return {
    connections: AGENT_CONNECTION_SOURCES.map(source => ({
      source,
      available: available[source] === true,
      enabled: available[source] === true && grants.has(source),
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

/// Check the live connection grant immediately before a native source call.
export async function mayUseAgentSource(env, { orgId, agentId, session, source }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || !session?.github_id || !agentId) return false;
  const [available, grants] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, session.github_id).catch(() => new Set()),
  ]);
  return available[source] === true && grants.has(source);
}
