import { connectedSources } from '../context.js';
import { getWorkspaceGitHub } from '../githubWorkspace.js';
import { EMAIL_AUTH_TOKEN } from '../auth.js';
import { mayRunAgent, mayAccessAgent } from './agents.js';

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
  const share = await db.prepare(`SELECT s.owner_github_id,s.owner_membership_since,s.created_at FROM hx_agent_source_shares s
    JOIN memberships m ON m.org_id=s.org_id AND m.user_github_id=s.owner_github_id
      AND m.created_at=s.owner_membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    JOIN custom_agents a ON a.org_id=s.org_id AND a.id=s.agent_id AND a.deleted_at IS NULL
    WHERE s.org_id=?1 AND s.agent_id=?2 AND s.source='notion'`)
    .bind(orgId, agentId).first();
  if (!share) return null;
  let ownerCanAccess;
  try { ownerCanAccess = await currentAgentAccess(db, orgId, agentId, share.owner_github_id); }
  catch { return null; }
  if (ownerCanAccess) return share;
  await db.prepare(`DELETE FROM hx_agent_source_shares WHERE org_id=?1 AND agent_id=?2 AND source='notion'
    AND owner_github_id=?3 AND owner_membership_since=?4 AND created_at=?5`)
    .bind(orgId, agentId, String(share.owner_github_id), share.owner_membership_since, share.created_at).run().catch(() => {});
  return null;
}

export async function hasAgentSourceGrant(db, { orgId, agentId, githubId, source }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || !githubId || !agentId) return false;
  return (await grantsFor(db, orgId, agentId, githubId)).has(source);
}

export async function agentSourceConnections(env, { orgId, agentId, session, canManageWorkspace = false }) {
  if (!session?.github_id || !orgId || !agentId) return { connections: [] };
  const githubId = String(session.github_id);
  const [available, grants, workspace, workspaceGrants, share, canAccessAgent] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, githubId).catch(() => new Set()),
    getWorkspaceGitHub(env.DB, orgId).catch(() => null),
    env.DB.prepare('SELECT source FROM hx_agent_workspace_source_grants WHERE org_id=?1 AND agent_id=?2')
      .bind(orgId, agentId).all().then(({ results = [] }) => new Set(results.map(row => row.source))).catch(() => new Set()),
    activeNotionShare(env.DB, orgId, agentId).catch(() => null),
    currentAgentAccess(env.DB, orgId, agentId, githubId).catch(() => false),
  ]);
  const workspaceAvailable = Boolean(workspace?.repo && (workspace?.token || (workspace?.composioUser && env.COMPOSIO_API_KEY)));
  const sharedNotionAvailable = Boolean(share && canAccessAgent && (await connectedSources(env, { github_id: String(share.owner_github_id) }, orgId).catch(() => ({}))).notion === true);
  return {
    connections: AGENT_CONNECTION_SOURCES.map(source => {
      const personalAvailable = source === 'github' ? personalGithubAvailable(session, orgId, workspace?.repo) : available[source] === true;
      const personal = {
        source,
        available: personalAvailable,
        enabled: personalAvailable && grants.has(source),
        canShare: source === 'notion' && available.notion === true && canAccessAgent && (!share || String(share.owner_github_id) === githubId),
        shareEnabled: source === 'notion' && Boolean(share && String(share.owner_github_id) === githubId),
        shared: source === 'notion' && sharedNotionAvailable,
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

/// Resolve which member's native connection this caller may use. Notion has
/// an explicit owner identity; GitHub keeps its existing personal/workspace
/// credential scope.
export async function agentSourceProvider(env, { orgId, agentId, session, source }) {
  if (!AGENT_CONNECTION_SOURCES.includes(source) || !session?.github_id || !agentId) return null;
  const githubId = String(session.github_id);
  if (!await currentAgentAccess(env.DB, orgId, agentId, githubId).catch(() => false)) return null;
  if (source === 'github') {
    const credential = await agentSourceCredential(env, { orgId, agentId, session, source });
    return credential ? githubId : null;
  }
  const [available, grants] = await Promise.all([
    connectedSources(env, session, orgId).catch(() => ({})),
    grantsFor(env.DB, orgId, agentId, githubId).catch(() => new Set()),
  ]);
  if (available.notion === true && grants.has('notion')) return githubId;
  const share = await activeNotionShare(env.DB, orgId, agentId).catch(() => null);
  if (!share?.owner_github_id) return null;
  const ownerId = String(share.owner_github_id);
  const ownerSources = await connectedSources(env, { github_id: ownerId }, orgId).catch(() => ({}));
  return ownerSources.notion === true ? ownerId : null;
}

export async function setAgentSourceShare(env, { orgId, agentId, session, source, enabled }) {
  if (source !== 'notion' || typeof enabled !== 'boolean') return { error: 'Sharing is currently supported for a personal Notion connection only.' };
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };
  if (enabled) {
    if (!await currentAgentAccess(env.DB, orgId, agentId, githubId).catch(() => false)) return { error: 'You need access to this Agent before sharing a connection with it.', status: 403 };
    const available = await connectedSources(env, session, orgId).catch(() => ({}));
    if (available.notion !== true) return { error: 'Connect Notion for this workspace before sharing it.', status: 409 };
    const stamp = new Date().toISOString();
    const member = await env.DB.prepare(`SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'`)
      .bind(orgId, githubId).first();
    if (!member) return { error: 'The workspace membership changed. Reload and try again.', status: 409 };
    await env.DB.prepare(`DELETE FROM hx_agent_source_shares WHERE org_id=?1 AND agent_id=?2 AND source='notion'
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=hx_agent_source_shares.org_id
        AND m.user_github_id=hx_agent_source_shares.owner_github_id AND m.created_at=hx_agent_source_shares.owner_membership_since
        AND LOWER(COALESCE(m.role,'guest'))!='guest')`).bind(orgId, agentId).run();
    await env.DB.prepare(`INSERT INTO hx_agent_source_shares (org_id,agent_id,owner_github_id,owner_membership_since,source,created_at)
      VALUES (?1,?2,?3,?4,'notion',?5) ON CONFLICT(org_id,agent_id,source) DO UPDATE SET
        owner_membership_since=excluded.owner_membership_since,created_at=excluded.created_at WHERE owner_github_id=excluded.owner_github_id`)
      .bind(orgId, agentId, githubId, member.created_at, stamp).run();
    const share = await activeNotionShare(env.DB, orgId, agentId).catch(() => null);
    if (String(share?.owner_github_id || '') !== githubId) return { error: 'Another Agent member already shared a Notion connection. Ask them to revoke it first.', status: 409 };
  } else {
    const share = await activeNotionShare(env.DB, orgId, agentId).catch(() => null);
    if (share && String(share.owner_github_id) !== githubId) return { error: 'Only the connection owner can revoke this share.', status: 403 };
    await env.DB.prepare(`DELETE FROM hx_agent_source_shares WHERE org_id=?1 AND agent_id=?2 AND source='notion' AND owner_github_id=?3`)
      .bind(orgId, agentId, githubId).run();
  }
  return agentSourceConnections(env, { orgId, agentId, session });
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
