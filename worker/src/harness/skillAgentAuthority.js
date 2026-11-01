// SQL parameters are supplied by trusted call sites; the predicate mirrors
// the route's agent owner, delegated admin and legacy workspace-admin rules.
export const skillAgentManager = (org, agent, user) => `EXISTS (SELECT 1 FROM custom_agents a
  JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=${user} AND LOWER(COALESCE(m.role,'guest'))!='guest'
  JOIN users u ON u.github_id=m.user_github_id
  WHERE a.org_id=${org} AND a.id=${agent} AND a.deleted_at IS NULL
    AND (a.scope!='personal' OR a.owner_login=u.login)
    AND (a.owner_login=u.login OR
      (a.scope='team' AND a.provider IS NULL
        AND EXISTS(SELECT 1 FROM hx_agent_profiles p WHERE p.org_id=a.org_id AND p.agent_id=a.id)
        AND EXISTS(SELECT 1 FROM hx_agent_members r WHERE r.org_id=a.org_id AND r.agent_id=a.id
          AND r.user_id=m.user_github_id AND r.role='admin' AND r.member_since=m.created_at)) OR
      (NOT EXISTS(SELECT 1 FROM hx_agent_profiles p WHERE p.org_id=a.org_id AND p.agent_id=a.id)
        AND LOWER(m.role) IN ('admin','owner'))))`;
