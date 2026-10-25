// Agent requests remain bound to the owned conversation that admitted them,
// even if that agent later becomes shared and ordinary file access survives.
export function documentOriginAuthority(org,scope,actor,payload){
 return `(COALESCE(json_extract(${payload},'$.origin'),'human')!='agent' OR EXISTS(
 SELECT 1 FROM custom_agents document_agent JOIN users document_user ON document_user.github_id=${actor}
 WHERE document_agent.org_id=${org} AND ${scope}='ag:'||document_agent.id||'|'||document_user.login
 AND document_agent.owner_login=document_user.login AND document_agent.deleted_at IS NULL))`;
}
