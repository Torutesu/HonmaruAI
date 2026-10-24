import {mayUseConversation} from './conversationAccess.js';

// A sourced automation borrows its creator's current origin access. Keep this
// check independent of the frozen executable definition so revocation applies
// to scheduled starts, approval continuation and model/tool-loop checks alike.
export async function workflowSourceMayRun(db,orgId,workflowId,creatorId){
 const source=await db.prepare('SELECT channel,created_by FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
 if(!source)return true;
 return String(source.created_by)===String(creatorId)&&await mayUseConversation(db,orgId,creatorId,source.channel);
}
