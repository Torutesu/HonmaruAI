import {sourceFingerprint} from './harness/agentAssignments.js';
import {getSession,getUserByGithubId,isMember,sessionByKey} from './db.js';
import {getMessage,resolveChannel,viewOf} from './channels.js';
import {listMembers} from './team.js';
import {respondingAgents} from './customAgents.js';
import {policyDenial} from './policy.js';

// Re-resolve authority from persisted state, including sign-out and current
// room/agent access. A queued request never carries a permanent permission.
export async function agentRequestGrant(env,{orgId,token,rowId}) {
  const session=String(token || '').startsWith('h1:')
    ? await sessionByKey(env.DB,token) : await getSession(env.DB,token);
  if(!session || !await isMember(env.DB,orgId,session.github_id) || await policyDenial(env,session,orgId))return null;
  const user=await getUserByGithubId(env.DB,session.github_id);
  const row=await getMessage(env.DB,orgId,rowId);
  if(!user?.login || !row || row.deleted_at || row.kind !== 'message' || row.author_login!==user.login)return null;
  const members=await listMembers(env.DB,orgId,session.github_id);
  const actor={...user,github_id:session.github_id};
  const view=viewOf(row.channel,user.login,members);
  const resolved=view ? await resolveChannel(env.DB,orgId,actor,view,members) : null;
  if(!resolved || resolved.key!==row.channel)return null;
  return {orgId,session,user:actor,row,members,resolved};
}

export async function agentExecutionGrant(env,request) {
  const grant=await agentRequestGrant(env,request);
  if(!grant)return null;
  let agents=await respondingAgents(env.DB,{orgId:grant.orgId,login:grant.user.login,resolved:grant.resolved,row:grant.row});
  const dispatch=await env.DB.prepare('SELECT session_key,agent_ids,source_hash,status FROM hx_agent_request_dispatch WHERE org_id=?1 AND message_id=?2').bind(grant.orgId,grant.row.id).first();
  if(dispatch) {
    if(dispatch.status==='cancelled'||dispatch.session_key!==grant.session.token||dispatch.source_hash!==await sourceFingerprint(grant.row))return null;
    let ids=[];try {ids=JSON.parse(dispatch.agent_ids);} catch {return null;}
    if(!Array.isArray(ids))return null;
    agents=agents.filter(agent=>ids.includes(agent.id));
  }
  return {...grant,agents};
}

export function agentExecutionAuthorizer(env,request,source) {
  return async (agentId=null)=>{
    const current=await agentExecutionGrant(env,request);
    if(!current || current.row.body!==source.body || current.row.channel!==source.channel
      || current.row.parent_id!==source.parent_id || current.row.author_login!==source.author_login)return false;
    return agentId ? current.agents.some(agent=>agent.id===agentId) : current.agents.length>0;
  };
}
