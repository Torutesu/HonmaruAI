import {getWorkflow} from './workflows.js';
import {getMessage} from '../channels.js';
import {mayUseConversation} from './conversationAccess.js';
import {isMember} from '../db.js';

async function threadCandidates(db,orgId,userId,input){
 const before=input?.before==null||input.before===''?null:Number(input.before);
 if(before!==null&&(!Number.isSafeInteger(before)||before<1))return {error:'Invalid thread cursor.',status:400};
 const {results}=await db.prepare(`SELECT rowid AS cursor,id,channel,body,created_at AS createdAt FROM channel_messages
   WHERE org_id=?1 AND parent_id IS NULL AND deleted_at IS NULL AND kind='message' AND (?2 IS NULL OR rowid<?2)
   ORDER BY rowid DESC LIMIT 51`).bind(orgId,before).all();
 const page=results.slice(0,50),access=new Map(),candidates=[];
 for(const root of page){
  if(!access.has(root.channel))access.set(root.channel,await mayUseConversation(db,orgId,userId,root.channel));
  if(access.get(root.channel))candidates.push({id:root.id,channel:root.channel,body:root.body.slice(0,240),createdAt:root.createdAt});
 }
 return {candidates,nextCursor:results.length>50?page[page.length-1].cursor:null};
}

// Source metadata is separate from executable/published definitions.
export async function workflowSource(db,orgId,userId,workflowId,input={},write=false,move=false){
 if(!await isMember(db,orgId,userId))return {error:'Workspace access required.',status:403};
 const workflow=await getWorkflow(db,orgId,workflowId,{viewerId:userId});
 if(!workflow)return {error:'No such workflow.',status:404};
 if(write){
  if(String(workflow.createdBy)!==String(userId))return {error:move?'Only the workflow creator can move its source thread.':'Only the workflow creator can select its source thread.',status:403};
  const root=typeof input.messageId==='string'?await getMessage(db,orgId,input.messageId):null;
  if(!root||root.deleted_at||root.parent_id||!await mayUseConversation(db,orgId,userId,root.channel))return {error:'No such source thread.',status:404};
  if(move){
   if(typeof input.expectedChannel!=='string'||!input.expectedChannel||typeof input.expectedThreadId!=='string'||!input.expectedThreadId)return {error:'Reload the source thread before moving it.',status:400};
   const current=await db.prepare('SELECT channel,thread_id AS threadId,created_by AS createdBy FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
   if(!current)return {error:'This automation has no source thread to move.',status:409};
   if(current.channel!==input.expectedChannel||current.threadId!==input.expectedThreadId)return {error:'The source thread changed. Reload before moving it.',status:409};
   if(current.channel===root.channel)return {error:'Choose a thread in a different Room.',status:400};
   const updated=await db.prepare(`UPDATE hx_workflow_sources SET channel=?1,thread_id=?2
    WHERE org_id=?3 AND workflow_id=?4 AND channel=?5 AND thread_id=?6 AND created_by=?7
    AND EXISTS(SELECT 1 FROM hx_workflows w WHERE w.org_id=?3 AND w.id=?4 AND w.created_by=?7)
    AND EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=?3 AND m.id=?2 AND m.channel=?1 AND m.parent_id IS NULL AND m.deleted_at IS NULL)`)
    .bind(root.channel,root.id,orgId,workflowId,input.expectedChannel,input.expectedThreadId,String(userId)).run();
   if(!updated.meta?.changes)return {error:'The source thread changed. Reload before moving it.',status:409};
  }else{
  await db.prepare(`INSERT OR IGNORE INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by)
    SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM channel_messages WHERE org_id=?1 AND id=?4 AND channel=?3 AND parent_id IS NULL AND deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?1 AND id=?2 AND created_by=?5)`)
    .bind(orgId,workflowId,root.channel,root.id,String(userId)).run();
  const source=await db.prepare('SELECT thread_id FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
  if(!source)return {error:'The source thread changed.',status:409};
  if(source.thread_id!==root.id)return {error:'This workflow already has a source thread.',status:409};
  }
 }
 const source=await db.prepare('SELECT channel,thread_id AS threadId,created_by AS createdBy FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
 if(!source){
  const canBind=String(workflow.createdBy)===String(userId);
  let candidates=[],nextCursor=null;
  if(canBind&&input?.candidates){
   const page=await threadCandidates(db,orgId,userId,input);if(page.error)return page;
   candidates=page.candidates;nextCursor=page.nextCursor;
  }
  return {source:null,canBind,canMove:false,candidates,nextCursor};
 }
 if(!await mayUseConversation(db,orgId,userId,source.channel))return {error:'Source thread access required.',status:403};
 const root=await getMessage(db,orgId,source.threadId);
 if(!root||root.deleted_at||root.parent_id||root.channel!==source.channel)return {error:'Source thread is unavailable.',status:404};
 const canMove=String(workflow.createdBy)===String(userId);
 let candidates=[],nextCursor=null;
 if(canMove&&input?.candidates){const page=await threadCandidates(db,orgId,userId,input);if(page.error)return page;candidates=page.candidates;nextCursor=page.nextCursor;}
 return {source:{...source,body:root.body.slice(0,240),createdAt:root.created_at},canBind:false,canMove,candidates,nextCursor};
}
