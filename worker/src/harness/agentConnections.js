import { connectedSources } from '../context.js';
import { getWorkspaceGitHub } from '../githubWorkspace.js';
import { EMAIL_AUTH_TOKEN } from '../auth.js';
import { mayRunAgent } from './agents.js';

export const AGENT_CONNECTION_SOURCES = ['notion', 'github'];

const personalGithubAvailable = (session, orgId, workspaceRepo = null) => Boolean(session?.github_access_token && session.github_access_token !== EMAIL_AUTH_TOKEN && /^[^/\s:]+\/[^/\s]+$/.test(String(workspaceRepo || orgId || '')));

async function grantsFor(db, orgId, agentId, githubId) {
  const { results = [] } = await db.prepare(`SELECT g.source FROM hx_agent_source_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id
      AND m.created_at=g.membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE g.org_id=?1 AND g.agent_id=?2 AND g.user_github_id=?3`)
    .bind(orgId, agentId, String(githubId)).all();
  return new Set(results.map(row => row.source));
}

export async function hasAgentSourceGrant(db, { orgId, agentId, githubId, source }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || !githubId || !agentId) return false;
  return (await grantsFor(db, orgId, agentId, githubId)).has(source);
}

export async function agentSourceConnections(env, { orgId, agentId, session, canManageWorkspace = false }) {
  if (!session?.github_id || !orgId || !agentId) return { connections: [] };
  const [available, grants, workspace, workspaceGrants] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, session.github_id).catch(() => new Set()),
    getWorkspaceGitHub(env.DB, orgId).catch(() => null),
    env.DB.prepare('SELECT source FROM hx_agent_workspace_source_grants WHERE org_id=?1 AND agent_id=?2')
      .bind(orgId, agentId).all().then(({ results = [] }) => new Set(results.map(row => row.source))).catch(() => new Set()),
  ]);
  const workspaceAvailable = Boolean(workspace?.repo && (workspace?.token || (workspace?.composioUser && env.COMPOSIO_API_KEY)));
  return {
    connections: AGENT_CONNECTION_SOURCES.map(source => {
      const personalAvailable = source === 'github' ? personalGithubAvailable(session, orgId, workspace?.repo) : available[source] === true;
      const personal = {
        source,
        available: personalAvailable,
        enabled: personalAvailable && grants.has(source),
      };
      return source === 'github' && workspaceAvailable ? {
        ...personal,
        workspaceAvailable: true,
        workspaceEnabled: workspaceGrants.has(source),
        canManageWorkspace: canManageWorkspace === true,
      } : personal;
    }),
  };
}

export async function setAgentWorkspaceSourceConnection(env, { orgId, agentId, source, enabled, actorId }) {
  if (source !== 'github' || typeof enabled !== 'boolean') return { error: 'Choose a supported workspace connection and whether to allow it.' };
  if (!actorId) return { error: 'Sign in again before changing this connection.', status: 401 };
  const workspace = await getWorkspaceGitHub(env.DB, orgId).catch(() => null);
  if (enabled && (!workspace?.repo || !(workspace?.token || (workspace?.composioUser && env.COMPOSIO_API_KEY)))) return { error: 'Connect a GitHub repository for this workspace before sharing it with the Agent.', status: 409 };
  const agent = await env.DB.prepare('SELECT id FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL')
    .bind(orgId, agentId).first();
  if (!agent) return { error: 'Agent not found in this workspace.', status: 404 };
  if (enabled) {
    await env.DB.prepare(`INSERT INTO hx_agent_workspace_source_grants (org_id,agent_id,source,granted_by,created_at)
      VALUES (?1,?2,'github',?3,?4)
      ON CONFLICT(org_id,agent_id,source) DO UPDATE SET granted_by=excluded.granted_by,created_at=excluded.created_at`)
      .bind(orgId, agentId, String(actorId), new Date().toISOString()).run();
  } else {
    await env.DB.prepare("DELETE FROM hx_agent_workspace_source_grants WHERE org_id=?1 AND agent_id=?2 AND source='github'")
      .bind(orgId, agentId).run();
  }
  return { ok: true };
}

export async function setAgentSourceConnection(env, { orgId, agentId, session, source, enabled }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || typeof enabled !== 'boolean') {
    return { error: 'Choose a supported connection and whether to allow it.' };
  }
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };
  if (enabled) {
    const available = source === 'github'
      ? personalGithubAvailable(session, orgId, (await getWorkspaceGitHub(env.DB, orgId).catch(() => null))?.repo)
      : (await connectedSources(env, session, orgId).catch(() => ({})))[source] === true;
    if (!available) return { error: `Connect your ${source === 'notion' ? 'Notion' : 'personal GitHub'} connection before allowing the Agent to use it.`, status: 409 };
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

export async function agentSourceCredential(env, { orgId, agentId, session, source }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || !session?.github_id || !agentId) return null;
  // Credential helpers are execution boundaries too: never rely on a caller
  // having filtered the Agent list before a connection grant is consumed.
  if (!await mayRunAgent(env.DB, orgId, { id: agentId }, session.github_id).catch(() => false)) return null;
  const githubId = String(session.github_id);
  if (source === 'github') {
    const workspace = await getWorkspaceGitHub(env.DB, orgId).catch(() => null);
    const shared = await env.DB.prepare("SELECT 1 FROM hx_agent_workspace_source_grants WHERE org_id=?1 AND agent_id=?2 AND source='github'")
      .bind(orgId, agentId).first().catch(() => null);
    if (workspace?.repo && (workspace?.token || (workspace?.composioUser && env.COMPOSIO_API_KEY)) && shared) return 'workspace';
    if (personalGithubAvailable(session, orgId, workspace?.repo) && (await grantsFor(env.DB, orgId, agentId, githubId)).has(source)) return 'personal';
    return null;
  }
  const available = await connectedSources(env, session, orgId).catch(() => ({}));
  return available[source] && (await grantsFor(env.DB, orgId, agentId, githubId)).has(source) ? 'personal' : null;
}

/// Check the live connection grant immediately before a native source call.
export async function mayUseAgentSource(env, args) {
  return Boolean(await agentSourceCredential(env, args));
}
