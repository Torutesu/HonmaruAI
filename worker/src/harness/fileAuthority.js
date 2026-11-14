import { resourceAudienceAccessSql } from "./externalResourceAudiences.js";

// SQL fragments use only trusted expressions supplied by internal callers.
// Check live membership and the exact stored audience in the mutation itself.
export function fileScopeAuthority(org,scope,actor) {
 return `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
 WHERE m.org_id=${org} AND m.user_github_id=${actor} AND lower(trim(m.role)) IN ('owner','admin','member','designer','engineer','triager','maintainer')
 AND NOT EXISTS(SELECT 1 FROM workspace_deletions deletion WHERE deletion.org_id=m.org_id AND deletion.purge_started_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM workspace_tombstones deleted WHERE deleted.org_id=m.org_id)
 AND (
 ${scope}='workspace'
 OR (substr(${scope},1,2)='b:' AND EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=m.org_id AND 'b:'||b.slug=${scope} AND b.archived_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM hx_room_access removed WHERE removed.org_id=b.org_id AND removed.channel=${scope} AND removed.deleted_at IS NOT NULL)
  AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=m.org_id AND c.channel=${scope} AND c.login=u.login))))
 OR (substr(${scope},1,2)='g:' AND EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=m.org_id AND c.channel=${scope} AND c.login=u.login))
 OR (substr(${scope},1,3)='dm:' AND EXISTS(SELECT 1 FROM users other JOIN memberships om ON om.user_github_id=other.github_id AND om.org_id=m.org_id
  WHERE other.login!=u.login AND (${scope}='dm:'||u.login||'|'||other.login OR ${scope}='dm:'||other.login||'|'||u.login)))
 OR (substr(${scope},1,3)='ag:' AND EXISTS(SELECT 1 FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
  WHERE a.org_id=m.org_id AND ${scope}='ag:'||a.id||'|'||u.login AND a.deleted_at IS NULL AND (a.scope='team' OR a.owner_login=u.login)
   AND ((a.scope='team' AND a.provider IS NULL AND p.agent_id IS NOT NULL AND EXISTS(SELECT 1 FROM hx_agent_members role WHERE role.org_id=a.org_id AND role.agent_id=a.id AND role.user_id=u.github_id AND role.member_since=m.created_at))
    OR p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
    OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.people) THEN p.people ELSE '[]' END) person WHERE person.value=u.login)))))
 ))`;
}
export function fileDeleteAuthority(org,creator,actor,scope) {
 return `(${creator}=${actor} OR EXISTS(SELECT 1 FROM memberships admin WHERE admin.org_id=${org} AND admin.user_github_id=${actor} AND lower(trim(admin.role)) IN ('owner','admin'))
 OR EXISTS(SELECT 1 FROM hx_room_roles role
  JOIN hx_room_access access ON access.org_id=role.org_id AND access.channel=role.channel AND access.deleted_at IS NULL
  JOIN memberships member ON member.org_id=role.org_id AND member.user_github_id=role.subject_id
  JOIN users person ON person.github_id=member.user_github_id
  JOIN conversation_members room_member ON room_member.org_id=role.org_id AND room_member.channel=role.channel AND room_member.login=person.login
  WHERE role.org_id=${org} AND role.channel=${scope} AND role.subject_kind='person' AND role.subject_id=${actor} AND role.role='admin'
   AND lower(trim(member.role)) IN ('owner','admin','member','designer','engineer','triager','maintainer') AND role.member_since=member.created_at||'/'||room_member.added_at))`;
}

// A Room Agent's placement and current calling grant are part of the write
// capability. `fileScopeAuthority` separately checks live human membership
// and room access; this fragment fences the Agent side at every storage
// mutation (reservation, upload stage, and version commit).
export function roomAgentFileAuthority(org,scope,actor,agentId,channel) {
 const literal=value=>`'${String(value).replaceAll("'","''")}'`;
 if(typeof agentId!=='string'||!agentId||agentId.length>200||/[\u0000-\u001f\u007f]/.test(agentId)||typeof channel!=='string'||!['b:','g:'].some(prefix=>channel.startsWith(prefix))||channel.length>200||/[\u0000-\u001f\u007f]/.test(channel)) throw new TypeError('Invalid Room Agent file authority.');
 const id=literal(agentId),room=literal(channel);
 return `EXISTS(SELECT 1 FROM custom_agents a JOIN users caller ON caller.github_id=${actor}
  JOIN memberships member ON member.org_id=a.org_id AND member.user_github_id=caller.github_id
    AND lower(trim(member.role)) IN ('owner','admin','member','designer','engineer','triager','maintainer')
  WHERE a.org_id=${org} AND a.id=${id} AND a.deleted_at IS NULL
   AND (a.scope='team' OR a.owner_login=caller.login)
   AND ${scope}=${room}
   AND EXISTS(SELECT 1 FROM channel_agents placed WHERE placed.org_id=a.org_id AND placed.channel=${room} AND placed.agent_id=a.id)
   AND (a.owner_login=caller.login
    OR NOT EXISTS(SELECT 1 FROM hx_agent_profiles profile WHERE profile.org_id=a.org_id AND profile.agent_id=a.id)
    OR EXISTS(SELECT 1 FROM hx_agent_profiles profile WHERE profile.org_id=a.org_id AND profile.agent_id=a.id AND (
      profile.access='everyone'
      OR (profile.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(profile.people) THEN profile.people ELSE '[]' END) person WHERE person.value=caller.login))
      OR (a.scope='team' AND EXISTS(SELECT 1 FROM hx_agent_members grant_row WHERE grant_row.org_id=a.org_id AND grant_row.agent_id=a.id AND grant_row.user_id=caller.github_id AND grant_row.member_since=member.created_at AND grant_row.role IN ('admin','member')))
    ))))`;
}

// Exact-file guest edits are intentionally narrower than workspace authority:
// External edit authority unions verified exact grants with current Room or
// workspace audiences. Every upload stage re-evaluates the same SQL fence.
export function externalFileEditAuthority(org,file,actor) {
 const access=resourceAudienceAccessSql({resourceType:'file',org: 'shared.org_id',resource:'shared.id',user:actor,
  now:"strftime('%Y-%m-%dT%H:%M:%fZ','now')",requiredPermission:'edit'});
 return `EXISTS(SELECT 1 FROM hx_workspace_files shared
  WHERE shared.org_id=${org} AND shared.id=${file}
   AND ${access}
   AND NOT EXISTS(SELECT 1 FROM workspace_deletions deletion WHERE deletion.org_id=shared.org_id AND deletion.purge_started_at IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM workspace_tombstones deleted WHERE deleted.org_id=shared.org_id)
   AND COALESCE((SELECT mode FROM org_settings setting WHERE setting.org_id=shared.org_id),'simple')='harness'
   AND shared.current_version>0
   AND EXISTS(SELECT 1 FROM hx_workspace_file_versions current WHERE current.org_id=shared.org_id AND current.file_id=shared.id AND current.version=shared.current_version AND current.kind='content')
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges purged WHERE purged.org_id=shared.org_id AND purged.file_id=shared.id AND purged.version=shared.current_version)
   AND NOT EXISTS(SELECT 1 FROM hx_room_access removed WHERE removed.org_id=shared.org_id AND removed.channel=shared.scope AND removed.deleted_at IS NOT NULL)
   AND (substr(shared.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses business WHERE business.org_id=shared.org_id AND 'b:'||business.slug=shared.scope AND business.archived_at IS NULL)))`;
}
