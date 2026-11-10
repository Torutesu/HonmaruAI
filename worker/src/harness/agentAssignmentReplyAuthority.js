// A model run rechecks this authority before starting work, but room/Agent
// membership can change between that check and the final SQL INSERT. Keep a
// compact copy of the live dispatch boundary in the same statement that
// publishes an assigned Agent reply.
export function assignmentReplyAuthority(assignment = 'a') {
  return `EXISTS (
    SELECT 1 FROM custom_agents ca
    JOIN users actor ON actor.github_id=${assignment}.actor_id
    LEFT JOIN hx_agent_profiles profile ON profile.org_id=ca.org_id AND profile.agent_id=ca.id
    WHERE ca.org_id=${assignment}.org_id AND ca.id=${assignment}.current_agent_id AND ca.deleted_at IS NULL
      AND (ca.scope!='personal' OR ca.owner_login=actor.login)
      AND EXISTS (SELECT 1 FROM channel_agents placement
        WHERE placement.org_id=ca.org_id AND placement.channel=${assignment}.channel AND placement.agent_id=ca.id)
      AND EXISTS (SELECT 1 FROM memberships member
        WHERE member.org_id=ca.org_id AND member.user_github_id=${assignment}.actor_id
          AND LOWER(TRIM(COALESCE(member.role,'guest')))!='guest')
      AND EXISTS (SELECT 1 FROM sessions session
        WHERE session.token=${assignment}.session_key AND session.github_id=${assignment}.actor_id
          AND (session.expires_at IS NULL OR session.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      AND (
        profile.agent_id IS NULL OR COALESCE(profile.access,'') NOT IN ('people','private') OR ca.owner_login=actor.login
        OR (profile.access='people' AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(profile.people) THEN profile.people ELSE '[]' END) person
          WHERE person.value=actor.login))
        OR (ca.scope='team' AND ca.provider IS NULL AND EXISTS (
          SELECT 1 FROM hx_agent_members role
          JOIN hx_agent_profiles roleProfile ON roleProfile.org_id=ca.org_id AND roleProfile.agent_id=ca.id
          JOIN memberships roleMember ON roleMember.org_id=role.org_id AND roleMember.user_github_id=role.user_id
            AND LOWER(TRIM(COALESCE(roleMember.role,'guest')))!='guest' AND roleMember.created_at=role.member_since
          WHERE role.org_id=ca.org_id AND role.agent_id=ca.id AND role.user_id=${assignment}.actor_id
            AND role.member_since=roleMember.created_at AND role.role IN ('admin','member')))
      )
  )`;
}
