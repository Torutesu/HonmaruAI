// SQL fragments use only trusted expressions supplied by internal callers.
// Check live membership and the exact stored audience in the mutation itself.
export function fileScopeAuthority(org,scope,actor) {
 return `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
 WHERE m.org_id=${org} AND m.user_github_id=${actor} AND lower(m.role) IN ('owner','admin','member','designer','engineer','triager','maintainer')
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
   AND lower(member.role) IN ('owner','admin','member','designer','engineer','triager','maintainer') AND role.member_since=member.created_at||'/'||room_member.added_at))`;
}

// Exact-file guest edits are intentionally narrower than workspace authority:
// the caller must remain a verified, non-member recipient of a live edit grant
// for this one file. Callers supply only internal SQL expressions.
export function externalFileEditAuthority(org,file,actor) {
 return `EXISTS(SELECT 1 FROM hx_external_resource_grants guest
  JOIN users identity ON identity.github_id=guest.recipient_github_id
  JOIN hx_workspace_files shared ON shared.org_id=guest.org_id AND shared.id=guest.resource_id
  WHERE guest.org_id=${org} AND guest.resource_type='file' AND guest.resource_id=${file}
   AND guest.recipient_github_id=${actor} AND guest.permission='edit' AND guest.revoked_at IS NULL
   AND (guest.expires_at IS NULL OR guest.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   AND identity.email_verified_at IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=guest.org_id AND member.user_github_id=${actor})
   AND NOT EXISTS(SELECT 1 FROM workspace_deletions deletion WHERE deletion.org_id=guest.org_id AND deletion.purge_started_at IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM workspace_tombstones deleted WHERE deleted.org_id=guest.org_id)
   AND COALESCE((SELECT mode FROM org_settings setting WHERE setting.org_id=guest.org_id),'simple')='harness'
   AND shared.current_version>0
   AND EXISTS(SELECT 1 FROM hx_workspace_file_versions current WHERE current.org_id=shared.org_id AND current.file_id=shared.id AND current.version=shared.current_version AND current.kind='content')
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges purged WHERE purged.org_id=shared.org_id AND purged.file_id=shared.id AND purged.version=shared.current_version)
   AND NOT EXISTS(SELECT 1 FROM hx_room_access removed WHERE removed.org_id=shared.org_id AND removed.channel=shared.scope AND removed.deleted_at IS NOT NULL)
   AND (substr(shared.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses business WHERE business.org_id=shared.org_id AND 'b:'||business.slug=shared.scope AND business.archived_at IS NULL)))`;
}
