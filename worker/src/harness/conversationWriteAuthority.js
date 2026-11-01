// Mirrors mayUseConversation for a canonical stored channel. Internal callers
// pass trusted SQL expressions; this runs in the same statement as the write.
export function conversationWriteAuthority(org, channel, actor) {
  return `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=${org} AND m.user_github_id=${actor} AND LOWER(COALESCE(m.role,'guest'))!='guest'
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions deletion WHERE deletion.org_id=m.org_id AND deletion.purge_started_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones deleted WHERE deleted.org_id=m.org_id) AND (
      (substr(${channel},1,2)='b:' AND EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=m.org_id AND 'b:'||b.slug=${channel}
        AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=m.org_id AND c.channel=${channel} AND c.login=u.login))))
      OR (substr(${channel},1,2)='g:' AND EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=m.org_id AND c.channel=${channel} AND c.login=u.login))
      OR (substr(${channel},1,3)='dm:' AND EXISTS(SELECT 1 FROM memberships otherMember JOIN users other ON other.github_id=otherMember.user_github_id
        WHERE otherMember.org_id=m.org_id AND other.login!=u.login AND (${channel}='dm:'||u.login||'|'||other.login OR ${channel}='dm:'||other.login||'|'||u.login)))
      OR (substr(${channel},1,3)='ag:' AND EXISTS(SELECT 1 FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
        WHERE a.org_id=m.org_id AND ${channel}='ag:'||a.id||'|'||u.login AND a.deleted_at IS NULL AND (a.scope='team' OR a.owner_login=u.login)
        AND (p.agent_id IS NULL OR p.access NOT IN ('people','private') OR a.owner_login=u.login
          OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.people) THEN p.people ELSE '[]' END) person WHERE person.value=u.login))
          OR (a.scope='team' AND a.provider IS NULL AND EXISTS(SELECT 1 FROM hx_agent_members role WHERE role.org_id=m.org_id AND role.agent_id=a.id AND role.user_id=u.github_id AND role.member_since=m.created_at)))))
    ))`;
}
