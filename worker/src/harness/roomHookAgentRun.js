import { roomHookExecutionGrant } from './roomHookExecutionGrant.js';
import { resolveChannel } from '../channels.js';
import { listMembers } from '../team.js';
import { respondingAgents } from '../customAgents.js';
import { runAgents } from '../channelRoutes.js';
import { roomHookAgentAllowed } from './roomHookAgentAccess.js';

// The receipt is the authority. No caller-provided user, body, channel or
// session token is accepted. Shared-room tools stay in their non-personal mode.
export async function runRoomHookAgents(env, { orgId, rowId }, { execute = runAgents } = {}) {
  const grant = await roomHookExecutionGrant(env.DB,orgId,rowId);
  if (!grant) return {status:'cancelled',answered:0};
  const members = await listMembers(env.DB,orgId,grant.creatorId);
  const resolved = await resolveChannel(env.DB,orgId,grant.user,grant.channel,members);
  if (!resolved || resolved.kind !== 'business' || resolved.key !== grant.channel) return {status:'cancelled',answered:0};
  const agents = await respondingAgents(env.DB,{orgId,login:grant.user.login,resolved,row:grant.row});
  if (!agents.length) return {status:'no_agents',answered:0};
  // Lookup may have involved several awaits. Recheck immediately before handing
  // off; runAgents receives the same guard for its asynchronous execution steps.
  const authorize = async (agentId = null) => agentId
    ? roomHookAgentAllowed(env.DB,orgId,rowId,agentId)
    : Boolean(await roomHookExecutionGrant(env.DB,orgId,rowId));
  if (!await authorize()) return {status:'cancelled',answered:0};
  const answered = await execute(env,{
    orgId, user:grant.user, resolved, row:grant.row, members, agents,
    session:{github_id:grant.creatorId}, locale:grant.user.locale || 'en', authorize, roomHookSource:true,
  });
  if (!answered && !await authorize()) return {status:'cancelled',answered:0};
  return {status:'finished',answered};
}
