import {getWorkflow} from './workflows.js';
import {getMessage} from '../channels.js';
import {mayUseConversation} from './conversationAccess.js';
import {isMember} from '../db.js';

// Source metadata is separate from executable/published definitions.
export async function workflowSource(db,orgId,userId,workflowId,input={},write=false){
 if(!await isMember(db,orgId,userId))return {error:'Workspace access required.',status:403};
 const workflow=await getWorkflow(db,orgId,workflowId,{viewerId:userId});
 if(!workflow)return {error:'No such workflow.',status:404};
 if(write){
  if(String(workflow.createdBy)!==String(userId))return {error:'Only the workflow creator can select its source thread.',status:403};
  const root=typeof input.messageId==='string'?await getMessage(db,orgId,input.messageId):null;
  if(!root||root.deleted_at||root.parent_id||!await mayUseConversation(db,orgId,userId,root.channel))return {error:'No such source thread.',status:404};
  await db.prepare(`INSERT OR IGNORE INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by)
    SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM channel_messages WHERE org_id=?1 AND id=?4 AND channel=?3 AND parent_id IS NULL AND deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?1 AND id=?2 AND created_by=?5)`)
    .bind(orgId,workflowId,root.channel,root.id,String(userId)).run();
  const source=await db.prepare('SELECT thread_id FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
  if(!source)return {error:'The source thread changed.',status:409};
  if(source.thread_id!==root.id)return {error:'This workflow already has a source thread.',status:409};
 }
 const source=await db.prepare('SELECT channel,thread_id AS threadId,created_by AS createdBy FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
 if(!source){
  const canBind=String(workflow.createdBy)===String(userId);
  const candidates=[];
  let nextCursor=null;
  if(canBind&&input?.candidates){
   const before=input.before==null||input.before===''?null:Number(input.before);
   if(before!==null&&(!Number.isSafeInteger(before)||before<1))return {error:'Invalid thread cursor.',status:400};
   const {results}=await db.prepare(`SELECT rowid AS cursor,id,channel,body,created_at AS createdAt FROM channel_messages
     WHERE org_id=?1 AND parent_id IS NULL AND deleted_at IS NULL AND kind='message' AND (?2 IS NULL OR rowid<?2)
     ORDER BY rowid DESC LIMIT 51`).bind(orgId,before).all();
   const page=results.slice(0,50),access=new Map();
   for(const root of page){
    if(!access.has(root.channel))access.set(root.channel,await mayUseConversation(db,orgId,userId,root.channel));
    if(access.get(root.channel))candidates.push({id:root.id,channel:root.channel,body:root.body.slice(0,240),createdAt:root.createdAt});
   }
   if(results.length>50)nextCursor=page[page.length-1].cursor;
  }
  return {source:null,canBind,candidates,nextCursor};
 }
 if(!await mayUseConversation(db,orgId,userId,source.channel))return {error:'Source thread access required.',status:403};
 const root=await getMessage(db,orgId,source.threadId);
 if(!root||root.deleted_at||root.parent_id||root.channel!==source.channel)return {error:'Source thread is unavailable.',status:404};
 return {source:{...source,body:root.body.slice(0,240),createdAt:root.created_at},canBind:false,candidates:[],nextCursor:null};
}
