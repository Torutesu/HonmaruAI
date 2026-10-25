// SQL fragments use only trusted expressions supplied by internal callers.
// Check live membership and the exact stored audience in the mutation itself.
export function fileScopeAuthority(org,scope,actor) {
 return `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
 WHERE m.org_id=${org} AND m.user_github_id=${actor} AND lower(m.role) IN ('owner','admin','member')
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
 return `(${creator}=${actor} OR EXISTS(SELECT 1 FROM memberships admin WHERE admin.org_id=${org} AND admin.user_github_id=${actor} AND lower(admin.role) IN ('owner','admin'))
 OR EXISTS(SELECT 1 FROM hx_room_roles role
  JOIN hx_room_access access ON access.org_id=role.org_id AND access.channel=role.channel AND access.deleted_at IS NULL
  JOIN memberships member ON member.org_id=role.org_id AND member.user_github_id=role.subject_id
  JOIN users person ON person.github_id=member.user_github_id
  JOIN conversation_members room_member ON room_member.org_id=role.org_id AND room_member.channel=role.channel AND room_member.login=person.login
  WHERE role.org_id=${org} AND role.channel=${scope} AND role.subject_kind='person' AND role.subject_id=${actor} AND role.role='admin'
   AND lower(member.role) IN ('owner','admin','member') AND role.member_since=member.created_at||'/'||room_member.added_at))`;
}
