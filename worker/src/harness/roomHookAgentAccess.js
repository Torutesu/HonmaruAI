import {roomHookExecutionGrant} from './roomHookExecutionGrant.js';
import {resolveChannel} from '../channels.js';
import {respondingAgents} from '../customAgents.js';

// Re-resolve routing and agent permissions after asynchronous work. A profile
// restricted or an agent removed since selection must not keep its old grant.
export async function roomHookAgentAllowed(db,orgId,messageId,agentId) {
 const grant=await roomHookExecutionGrant(db,orgId,messageId);
 if(!grant)return false;
 const resolved=await resolveChannel(db,orgId,grant.user,grant.channel);
 if(!resolved||resolved.kind!=='business'||resolved.key!==grant.channel)return false;
 const agents=await respondingAgents(db,{orgId,login:grant.user.login,resolved,row:grant.row});
 return agents.some(agent=>agent.id===agentId);
}
