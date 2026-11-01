// Authorize every schema that may enter a model prompt at the same instant.
// Captured app entities must still have the same keys and table identities;
// extra workspace tables are also checked because automation prompts list them.
import { conversationWriteAuthority } from './conversationWriteAuthority.js';

export async function mayGenerateFromSchema(db, orgId, appId, userId, entities, extraTables = [], guard = null, agents = [], capabilities = null) {
  if (!userId || !Array.isArray(entities) || !entities.length || entities.some(e => !e?.key || !e.table?.id)) return false;
  if (capabilities && (!Array.isArray(capabilities.actions) || !Array.isArray(capabilities.connections) || !Array.isArray(capabilities.gateways))) return false;
  const references = entities.map(e => ({key:e.key, id:e.table.id}));
  const tables = [...entities.map(e=>e.table), ...extraTables];
  if (tables.some(t => !t || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || typeof t.updatedAt !== 'string' || !Array.isArray(t.columns))) return false;
  const snapshots = tables.map(t=>({id:t.id,name:t.name,updatedAt:t.updatedAt,columns:t.columns}));
  // When a source is present, check its captured rules and all captured agent
  // visibility in the same D1 statement as the table schemas. Separate
  // await-ed checks can otherwise each observe a different authorization
  // state. A subsequent external request cannot be atomic with this read.
  const row = await db.prepare(`SELECT 1 AS allowed FROM memberships m
    JOIN users u ON u.github_id=m.user_github_id
    JOIN hx_apps target ON target.org_id=m.org_id AND target.id=?2
    LEFT JOIN hx_app_access policy ON policy.org_id=target.org_id AND policy.app_id=target.id
    WHERE m.org_id=?1 AND m.user_github_id=?3 AND lower(coalesce(m.role,'guest'))!='guest'
      AND (target.created_by=?3 OR lower(m.role) IN ('admin','owner'))
      AND (coalesce(policy.visibility,'workspace')='workspace' OR target.created_by=?3)
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)
      AND (SELECT count(*)+1 FROM hx_app_entities WHERE org_id=?1 AND app_id=?2)=json_array_length(?4)
      AND NOT EXISTS(SELECT 1 FROM json_each(?4) e WHERE NOT (
        (json_extract(e.value,'$.key')='primary' AND target.table_id=json_extract(e.value,'$.id')) OR
        EXISTS(SELECT 1 FROM hx_app_entities current WHERE current.org_id=?1 AND current.app_id=?2
          AND current.entity_key=json_extract(e.value,'$.key') AND current.table_id=json_extract(e.value,'$.id'))))
      AND NOT EXISTS(SELECT 1 FROM json_each(?5) scope WHERE
        NOT EXISTS(SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(scope.value,'$.id')
          AND t.name=json_extract(scope.value,'$.name') AND t.updated_at=json_extract(scope.value,'$.updatedAt')
          AND json(t.columns)=json(json_extract(scope.value,'$.columns')))
        OR EXISTS(SELECT 1 FROM (
          SELECT a.id FROM hx_apps a WHERE a.org_id=?1 AND a.table_id=json_extract(scope.value,'$.id')
          UNION SELECT e.app_id AS id FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=json_extract(scope.value,'$.id')
        ) refs LEFT JOIN hx_apps linked ON linked.org_id=?1 AND linked.id=refs.id
          LEFT JOIN hx_app_access p ON p.org_id=linked.org_id AND p.app_id=linked.id
          WHERE linked.id IS NULL OR (coalesce(p.visibility,'workspace')!='workspace' AND linked.created_by IS NOT ?3)))
      AND (?6 IS NULL OR (m.created_at IS json_extract(?6,'$.original.memberSince')
        AND u.login IS json_extract(?6,'$.original.login')
        AND target.created_by IS json_extract(?6,'$.original.appOwner')
        AND target.created_at IS json_extract(?6,'$.original.appCreatedAt')
        AND (json_extract(?6,'$.source.channel') IS NULL OR EXISTS(
          SELECT 1 FROM hx_app_conversation_sources s
          JOIN businesses b ON b.org_id=s.org_id AND 'b:'||b.slug=s.channel
          JOIN channel_messages root ON root.org_id=s.org_id AND root.id=s.thread_id AND root.channel=s.channel AND root.parent_id IS NULL AND root.deleted_at IS NULL
          LEFT JOIN conversation_members c ON c.org_id=s.org_id AND c.channel=s.channel AND c.login=u.login
          LEFT JOIN hx_room_guidelines g ON g.org_id=s.org_id AND g.channel=s.channel
          LEFT JOIN hx_room_access access ON access.org_id=s.org_id AND access.channel=s.channel
          WHERE s.org_id=?1 AND s.app_id=?2 AND s.channel=json_extract(?6,'$.source.channel') AND s.thread_id=json_extract(?6,'$.source.threadId')
            AND b.archived_at IS NULL AND access.deleted_at IS NULL
            AND b.created_at IS json_extract(?6,'$.original.roomCreatedAt') AND b.private IS json_extract(?6,'$.original.roomPrivate')
            AND (CASE WHEN b.private=1 THEN c.added_at ELSE NULL END) IS json_extract(?6,'$.original.roomMemberSince')
            AND coalesce(g.body,'') IS json_extract(?6,'$.original.body') AND coalesce(g.version,0) IS json_extract(?6,'$.original.version')
            AND ${conversationWriteAuthority('?1','s.channel','?3')}))))
      AND NOT EXISTS(SELECT 1 FROM json_each(?7) requested WHERE NOT EXISTS(
        SELECT 1 FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
        WHERE a.org_id=?1 AND a.id=json_extract(requested.value,'$.id') AND a.name=json_extract(requested.value,'$.name')
          AND a.deleted_at IS NULL AND (a.scope='team' OR a.owner_login=u.login)
          AND ((a.scope='team' AND a.provider IS NULL AND p.agent_id IS NOT NULL AND EXISTS(
            SELECT 1 FROM hx_agent_members r WHERE r.org_id=?1 AND r.agent_id=a.id AND r.user_id=?3 AND r.member_since=m.created_at))
            OR (a.scope!='personal' OR a.owner_login=u.login) AND (
              p.agent_id IS NULL OR p.access NOT IN ('private','people') OR a.owner_login=u.login OR
              (p.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.people) THEN p.people ELSE '[]' END) x WHERE x.value=u.login))))))
      AND (?8 IS NULL OR (
        (SELECT COUNT(*) FROM hx_app_actions a WHERE a.org_id=?1 AND a.app_id=?2 AND a.published IS NOT NULL AND a.published!='')=json_array_length(?8,'$.actions')
        AND NOT EXISTS(SELECT 1 FROM json_each(?8,'$.actions') captured WHERE NOT EXISTS(
          SELECT 1 FROM hx_app_actions a WHERE a.org_id=?1 AND a.app_id=?2 AND a.name=json_extract(captured.value,'$.name')
            AND a.published IS json_extract(captured.value,'$.code') AND a.version IS json_extract(captured.value,'$.version')
            AND a.published_version IS json_extract(captured.value,'$.publishedVersion') AND a.published IS NOT NULL AND a.published!=''))
        AND (SELECT COUNT(*) FROM hx_app_connections c WHERE c.org_id=?1 AND c.app_id=?2 AND c.created_by=?3)=json_array_length(?8,'$.connections')
        AND NOT EXISTS(SELECT 1 FROM json_each(?8,'$.connections') captured WHERE NOT EXISTS(
          SELECT 1 FROM hx_app_connections c WHERE c.org_id=?1 AND c.app_id=?2 AND c.created_by=?3
            AND c.name=json_extract(captured.value,'$.name') AND c.endpoint IS json_extract(captured.value,'$.endpoint')
            AND c.method IS json_extract(captured.value,'$.method') AND c.enabled IS json_extract(captured.value,'$.enabled')
            AND c.version IS json_extract(captured.value,'$.version')))
        AND (SELECT COUNT(*) FROM hx_gateways g WHERE g.org_id=?1 AND g.revoked_at IS NULL)=json_array_length(?8,'$.gateways')
        AND NOT EXISTS(SELECT 1 FROM json_each(?8,'$.gateways') captured WHERE NOT EXISTS(
          SELECT 1 FROM hx_gateways g WHERE g.org_id=?1 AND g.revoked_at IS NULL
            AND g.id=json_extract(captured.value,'$.id') AND g.name IS json_extract(captured.value,'$.name')
            AND g.created_at IS json_extract(captured.value,'$.createdAt')))))`)
    .bind(orgId,appId,String(userId),JSON.stringify(references),JSON.stringify(snapshots),guard?JSON.stringify(guard):null,JSON.stringify(agents),capabilities?JSON.stringify({actions:capabilities.actions,connections:capabilities.connections,gateways:capabilities.gateways}):null).first();
  return Boolean(row);
}

// Cleanup may await reservation storage; access must be checked afterwards,
// immediately before the response is returned.
export async function finishSchemaGeneration(complete, authorize, generate) {
  let result;
  try { result=await generate(); }
  finally { await complete?.dispose?.(); }
  return await authorize()?result:{error:'No such app.',status:404};
}
