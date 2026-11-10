import { mayAccessAgent } from './agents.js';
import { mayUseApp } from './resourceAccess.js';
import { invokeConnection, connections as ownedConnections } from './appCapabilities.js';

const err = (error, status = 400) => ({ error, status });

async function sourceAgent(db, orgId, appId) {
  const source = await db.prepare(`SELECT s.channel,s.thread_id AS threadId,a.id,a.name,a.scope,a.owner_login AS ownerLogin
    FROM hx_app_conversation_sources s JOIN custom_agents a ON a.org_id=s.org_id AND a.deleted_at IS NULL
      AND s.channel LIKE 'ag:'||a.id||'|%'
    JOIN channel_messages root ON root.org_id=s.org_id AND root.channel=s.channel AND root.id=s.thread_id
      AND root.deleted_at IS NULL AND root.parent_id IS NULL
    WHERE s.org_id=?1 AND s.app_id=?2`).bind(orgId, appId).first();
  const match = String(source?.channel || '').match(/^ag:([\w-]{1,64})\|([a-zA-Z0-9-]{1,64})$/);
  return match && match[1] === source.id ? { ...source, sourceLogin: match[2] } : null;
}

async function memberLogin(db, orgId, userId) {
  return db.prepare(`SELECT u.login,m.created_at AS membershipSince FROM memberships m
    JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND m.user_github_id=?2 AND LOWER(COALESCE(m.role,'guest'))!='guest'
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=m.org_id AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=m.org_id)`)
    .bind(orgId, String(userId)).first();
}

async function mayUseSourceAgent(db, orgId, agent, userId) {
  const member = await memberLogin(db, orgId, userId);
  return Boolean(member && await mayAccessAgent(db, orgId, agent, member.login));
}

async function mayUseAppAsMember(db, orgId, appId, userId) {
  return Boolean(await memberLogin(db, orgId, userId) && await mayUseApp(db, orgId, appId, userId));
}

async function getGrant(db, orgId, appId, name, viewerId) {
  const source = await sourceAgent(db, orgId, appId);
  if (!source || !await mayUseSourceAgent(db, orgId, source, viewerId)) return null;
  const { results = [] } = await db.prepare(`SELECT g.connection_owner_id AS ownerId,g.owner_membership_since AS ownerMembershipSince,
      g.source_agent_id AS sourceAgentId,g.endpoint,g.method,g.created_at AS createdAt,
      g.connection_version AS grantVersion,
      c.version,c.enabled,c.endpoint AS currentEndpoint,c.method AS currentMethod,
      m.created_at AS currentMembershipSince
    FROM hx_app_connection_grants g
    JOIN hx_app_connections c ON c.org_id=g.org_id AND c.app_id=g.app_id
      AND c.created_by=g.connection_owner_id AND c.name=g.connection_name
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.connection_owner_id
      AND m.created_at=g.owner_membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE g.org_id=?1 AND g.app_id=?2 AND g.connection_name=?3
      AND g.source_agent_id=?4 AND c.enabled=1 AND c.version=g.connection_version
      AND c.endpoint=g.endpoint AND c.method=g.method`)
    .bind(orgId, appId, String(name), source.id).all();
  for (const grant of results) {
    if (!await mayUseSourceAgent(db, orgId, source, grant.ownerId)) continue;
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND name=?3')
      .bind(orgId, appId, String(name)).first() || {};
    // The App runtime addresses a connection by its stable name. Never let a
    // later same-name connection silently redirect an existing grant.
    if (Number(n) !== 1) return null;
    return { ...grant, source };
  }
  return null;
}

async function sourceAgentGrantAuthority(db, orgId, appId, actorId) {
  const source = await sourceAgent(db, orgId, appId);
  const actor = await memberLogin(db, orgId, actorId);
  // The connection owner may be a different workspace member from the
  // person who opened the source Agent DM. Sharing is safe only when the
  // owner opts in with their own credential and still has current access to
  // both this App and its source Agent.
  if (!source || !actor || !await mayUseSourceAgent(db, orgId, source, actorId)) return null;
  return { ...source, actor, membershipSince: actor.membershipSince };
}

export async function appConnectionsForViewer(db, orgId, appId, viewerId) {
  if (!await mayUseAppAsMember(db, orgId, appId, viewerId)) return err('No such app.', 404);
  const own = await ownedConnections(db, orgId, appId, viewerId);
  const source = await sourceAgent(db, orgId, appId);
  const sourceAccess = source && await mayUseSourceAgent(db, orgId, source, viewerId);
  const { results = [] } = await db.prepare(`SELECT c.name,c.version,c.endpoint,c.method,c.enabled,
      CASE WHEN c.token IS NOT NULL THEN 1 ELSE 0 END AS hasToken,
      c.created_by AS ownerId,COALESCE(u.name,u.login,'Workspace member') AS ownerName,
      g.created_at AS grantCreatedAt
    FROM hx_app_connection_grants g JOIN hx_app_connections c
      ON c.org_id=g.org_id AND c.app_id=g.app_id AND c.created_by=g.connection_owner_id AND c.name=g.connection_name
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.connection_owner_id
      AND m.created_at=g.owner_membership_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    LEFT JOIN users u ON u.github_id=c.created_by
    WHERE g.org_id=?1 AND g.app_id=?2 AND g.source_agent_id=?3 AND c.enabled=1 AND c.version=g.connection_version
      AND c.endpoint=g.endpoint AND c.method=g.method AND c.created_by!=?4
      AND NOT EXISTS(SELECT 1 FROM hx_app_connections other WHERE other.org_id=c.org_id AND other.app_id=c.app_id
        AND other.name=c.name AND other.created_by!=c.created_by)`)
    .bind(orgId, appId, source?.id || '', String(viewerId)).all();
  const visible = [];
  if (sourceAccess) for (const row of results || []) {
    if (await mayUseSourceAgent(db, orgId, source, row.ownerId)) visible.push({ ...row, owned: false, shared: true, canShare: false });
  }
  const ownRows = [];
  for (const row of own.connections || []) {
    const grant = await db.prepare(`SELECT source_agent_id AS sourceAgentId,connection_version AS connectionVersion,endpoint,method FROM hx_app_connection_grants
      WHERE org_id=?1 AND app_id=?2 AND connection_owner_id=?3 AND connection_name=?4`)
      .bind(orgId, appId, String(viewerId), row.name).first();
    const live = Boolean(grant && sourceAccess && grant.sourceAgentId === source?.id && grant.connectionVersion === row.version && grant.endpoint === row.endpoint && grant.method === row.method && Number(row.enabled) === 1);
    const collision = Number((await db.prepare('SELECT COUNT(*) AS n FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND name=?3').bind(orgId, appId, row.name).first())?.n || 0) !== 1;
    const canShare = Boolean(source && sourceAccess && !collision && Number(row.enabled) === 1);
    ownRows.push({ ...row, ownerId: String(viewerId), owned: true, shared: live, grantExists: Boolean(grant), canShare, ...(sourceAccess ? { sourceAgentName: source.name || source.id } : {}) });
  }
  return { connections: [...ownRows, ...visible], hosts: own.hosts, ...(sourceAccess ? { sourceAgent: { id: source.id, name: source.name || source.id } } : {}) };
}

export async function changeAppConnectionGrant(db, orgId, appId, actorId, input) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(input?.name || '')) || !['grant', 'revoke'].includes(input?.action)) return err('Choose a connection and grant or revoke App access.');
  const name = String(input.name);
  const connection = await db.prepare(`SELECT endpoint,method,enabled,version FROM hx_app_connections
    WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4`).bind(orgId, appId, String(actorId), name).first();
  if (input.action === 'revoke') {
    if (!await mayUseAppAsMember(db, orgId, appId, actorId) || !connection) return err('No such connection.', 404);
    await db.prepare(`DELETE FROM hx_app_connection_grants WHERE org_id=?1 AND app_id=?2 AND connection_owner_id=?3 AND connection_name=?4`)
      .bind(orgId, appId, String(actorId), name).run();
    return { revoked: true };
  }
  if (!connection || Number(connection.enabled) !== 1) return err('Enable this connection before granting App access.', 404);
  if (!await mayUseAppAsMember(db, orgId, appId, actorId)) return err('No such app.', 404);
  const authority = await sourceAgentGrantAuthority(db, orgId, appId, actorId);
  if (!authority) return err('Only a person with current access to this App’s source Agent can grant this connection.', 403);
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND name=?3')
    .bind(orgId, appId, name).first() || {};
  if (Number(n) !== 1) return err('Connection names must be unique in this App before they can be shared.', 409);
  const at = new Date().toISOString();
  const saved=await db.prepare(`INSERT INTO hx_app_connection_grants
      (org_id,app_id,connection_owner_id,connection_name,connection_version,owner_membership_since,source_agent_id,endpoint,method,granted_by,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?3,?10
    WHERE EXISTS(SELECT 1 FROM hx_app_connections c WHERE c.org_id=?1 AND c.app_id=?2
      AND c.created_by=?3 AND c.name=?4 AND c.version=?5 AND c.endpoint=?8 AND c.method=?9 AND c.enabled=1)
      AND NOT EXISTS(SELECT 1 FROM hx_app_connections other WHERE other.org_id=?1 AND other.app_id=?2
        AND other.name=?4 AND other.created_by!=?3)
      AND EXISTS(SELECT 1 FROM hx_apps app JOIN memberships member
        ON member.org_id=app.org_id AND member.user_github_id=?3 AND member.created_at=?6
        LEFT JOIN hx_app_access policy ON policy.org_id=app.org_id AND policy.app_id=app.id
        WHERE app.org_id=?1 AND app.id=?2 AND LOWER(COALESCE(member.role,'guest'))!='guest'
          AND (COALESCE(policy.visibility,'workspace')='workspace' OR app.created_by=?3)
          AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1))
      AND EXISTS(SELECT 1 FROM hx_app_conversation_sources source
        JOIN channel_messages root ON root.org_id=source.org_id AND root.channel=source.channel
          AND root.id=source.thread_id AND root.deleted_at IS NULL AND root.parent_id IS NULL
        JOIN custom_agents agent ON agent.org_id=source.org_id AND agent.id=?7 AND agent.deleted_at IS NULL
        JOIN users actor ON actor.github_id=?3
        JOIN memberships member ON member.org_id=agent.org_id AND member.user_github_id=actor.github_id
          AND LOWER(COALESCE(member.role,'guest'))!='guest'
        LEFT JOIN hx_agent_profiles profile ON profile.org_id=agent.org_id AND profile.agent_id=agent.id
        WHERE source.org_id=?1 AND source.app_id=?2 AND source.channel=?11
          AND (agent.scope!='personal' OR agent.owner_login=actor.login)
          AND (COALESCE(profile.access,'everyone') NOT IN ('people','private') OR agent.owner_login=actor.login
            OR (profile.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(profile.people) THEN profile.people ELSE '[]' END) person WHERE person.value=actor.login))
            OR (agent.scope='team' AND agent.provider IS NULL AND profile.agent_id IS NOT NULL
              AND EXISTS(SELECT 1 FROM hx_agent_members role JOIN memberships current
                ON current.org_id=role.org_id AND current.user_github_id=role.user_id AND current.created_at=role.member_since
                WHERE role.org_id=agent.org_id AND role.agent_id=agent.id AND role.user_id=actor.github_id))))
    ON CONFLICT(org_id,app_id,connection_owner_id,connection_name) DO UPDATE SET
      connection_version=excluded.connection_version,owner_membership_since=excluded.owner_membership_since,
      source_agent_id=excluded.source_agent_id,endpoint=excluded.endpoint,method=excluded.method,
      granted_by=excluded.granted_by,created_at=excluded.created_at
    WHERE EXISTS(SELECT 1 FROM hx_app_connections c WHERE c.org_id=excluded.org_id AND c.app_id=excluded.app_id
      AND c.created_by=excluded.connection_owner_id AND c.name=excluded.connection_name
      AND c.version=excluded.connection_version AND c.endpoint=excluded.endpoint AND c.method=excluded.method AND c.enabled=1)
      AND NOT EXISTS(SELECT 1 FROM hx_app_connections other WHERE other.org_id=excluded.org_id AND other.app_id=excluded.app_id
        AND other.name=excluded.connection_name AND other.created_by!=excluded.connection_owner_id)
      AND EXISTS(SELECT 1 FROM hx_apps app JOIN memberships member
        ON member.org_id=app.org_id AND member.user_github_id=excluded.connection_owner_id AND member.created_at=excluded.owner_membership_since
        LEFT JOIN hx_app_access policy ON policy.org_id=app.org_id AND policy.app_id=app.id
        WHERE app.org_id=excluded.org_id AND app.id=excluded.app_id AND LOWER(COALESCE(member.role,'guest'))!='guest'
          AND (COALESCE(policy.visibility,'workspace')='workspace' OR app.created_by=excluded.connection_owner_id)
          AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=excluded.org_id AND d.purge_started_at IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=excluded.org_id))`)
    .bind(orgId, appId, String(actorId), name, connection.version, authority.membershipSince, authority.id, connection.endpoint, connection.method, at, authority.channel).run();
  if(!saved.meta?.changes)return err('Connection changed while sharing. Reload and try again.',409);
  return { granted: true };
}

export async function invokeAppConnection(env, orgId, appId, viewerId, input) {
  const db = env.DB;
  if (!await mayUseAppAsMember(db, orgId, appId, viewerId)) return err('No such app.', 404);
  const name = String(input?.name || '');
  const own = await db.prepare('SELECT name FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND enabled=1')
    .bind(orgId, appId, String(viewerId), name).first();
  let grant = null;
  if (!own) {
    grant = await getGrant(db, orgId, appId, name, viewerId);
    if (!grant) return err('No enabled connection granted to this App visitor.', 404);
  }
  const ownerId = grant ? String(grant.ownerId) : String(viewerId);
  const result = await invokeConnection(db, orgId, appId, ownerId, input);
  if (result.error) return result;
  if (!await mayUseAppAsMember(db, orgId, appId, viewerId)) return err('App access changed while the connection was running; the result was discarded.', 403);
  if (grant) {
    const current = await getGrant(db, orgId, appId, name, viewerId);
    if (!current || current.createdAt !== grant.createdAt || current.version !== grant.version || current.grantVersion !== grant.grantVersion || current.ownerMembershipSince !== grant.ownerMembershipSince) {
      return err('Connection access changed while the request was running; the result was discarded.', 403);
    }
  }
  return result;
}
