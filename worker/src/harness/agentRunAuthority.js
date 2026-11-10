// SQL equivalent of mayRunAgent for a workflow's current creator. The
// membership timestamp prevents a removed/re-added person inheriting an old
// explicit Agent grant.
export function agentRunAuthority(org, userId, agentId) {
  return `EXISTS(SELECT 1 FROM custom_agents current_agent
    JOIN users agent_user ON agent_user.github_id=${userId}
    JOIN memberships agent_member ON agent_member.org_id=current_agent.org_id
      AND agent_member.user_github_id=agent_user.github_id AND LOWER(TRIM(COALESCE(agent_member.role,'guest')))!='guest'
    LEFT JOIN hx_agent_profiles agent_profile ON agent_profile.org_id=current_agent.org_id AND agent_profile.agent_id=current_agent.id
    WHERE current_agent.org_id=${org} AND current_agent.id=${agentId} AND current_agent.deleted_at IS NULL
      AND ((current_agent.scope='team' AND current_agent.provider IS NULL AND agent_profile.agent_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM hx_agent_members explicit_role
          WHERE explicit_role.org_id=current_agent.org_id AND explicit_role.agent_id=current_agent.id
            AND explicit_role.user_id=agent_user.github_id AND explicit_role.member_since=agent_member.created_at))
        OR ((current_agent.scope!='personal' OR current_agent.owner_login=agent_user.login)
          AND (agent_profile.agent_id IS NULL
            OR COALESCE(CASE WHEN agent_profile.access IN ('everyone','people','private') THEN agent_profile.access ELSE 'everyone' END,'everyone')='everyone'
            OR current_agent.owner_login=agent_user.login
            OR (COALESCE(CASE WHEN agent_profile.access IN ('everyone','people','private') THEN agent_profile.access ELSE 'everyone' END,'everyone')='people'
              AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(agent_profile.people) THEN agent_profile.people ELSE '[]' END) person WHERE person.value=agent_user.login))))))`;
}
