// postMessage's parameters: workspace ?2, channel ?3, author ?4, parent ?9;
// internal notice identity: workflow ?14, generation ?15, creator ?16.
export const workflowNoticeGuard=`EXISTS (
 SELECT 1 FROM hx_workflow_safety_notices n
 JOIN hx_workflow_safety s ON s.org_id=n.org_id AND s.workflow_id=n.workflow_id AND s.generation=n.generation
 JOIN hx_workflows w ON w.org_id=n.org_id AND w.id=n.workflow_id AND w.created_by=n.recipient_id
 JOIN hx_workflow_sources source ON source.org_id=n.org_id AND source.workflow_id=n.workflow_id AND source.created_by=n.recipient_id
 JOIN memberships m ON m.org_id=n.org_id AND m.user_github_id=n.recipient_id
 JOIN users u ON u.github_id=n.recipient_id
 WHERE n.org_id=?2 AND n.workflow_id=?14 AND n.generation=?15 AND n.recipient_id=?16
 AND s.paused_at IS NOT NULL AND m.role!='guest' AND source.channel=?3 AND source.thread_id=?9
 AND ?4='__workflow'
 AND (
  (substr(?3,1,2)='b:' AND EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=?2 AND 'b:'||b.slug=?3 AND b.archived_at IS NULL
    AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=?2 AND c.channel=?3 AND c.login=u.login))))
  OR (substr(?3,1,2)='g:' AND EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=?2 AND c.channel=?3 AND c.login=u.login))
  OR (substr(?3,1,3)='dm:' AND EXISTS(SELECT 1 FROM users other JOIN memberships om ON om.user_github_id=other.github_id AND om.org_id=?2
    WHERE other.login!=u.login AND (?3='dm:'||u.login||'|'||other.login OR ?3='dm:'||other.login||'|'||u.login)))
  OR (substr(?3,1,3)='ag:' AND EXISTS(SELECT 1 FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
    WHERE a.org_id=?2 AND ?3='ag:'||a.id||'|'||u.login AND a.deleted_at IS NULL
    AND (a.scope='team' OR a.owner_login=u.login)
    AND ((a.scope='team' AND a.provider IS NULL AND p.agent_id IS NOT NULL AND EXISTS(SELECT 1 FROM hx_agent_members role WHERE role.org_id=?2 AND role.agent_id=a.id AND role.user_id=u.github_id AND role.member_since=m.created_at)) OR p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
      OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.people) THEN p.people ELSE '[]' END) person WHERE person.value=u.login)))))
 ))`;
