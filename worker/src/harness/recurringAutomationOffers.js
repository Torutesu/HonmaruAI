import {getMode} from './mode.js';
import {mayUseConversation} from './conversationAccess.js';
import {getMessage} from '../channels.js';
import {getWorkflow} from './workflows.js';
import {generateWorkflow} from './workflowCreation.js';

// Deliberately require an explicit cadence phrase; incidental uses of
// "repeat" in a discussion should not create an offer or an Automation.
export function isRecurringWorkPrompt(value){
 const text=String(value||'').normalize('NFKC').toLowerCase();
 const cadence=/\b(?:every|each)\s+(?:day|week|month|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:daily|weekly|monthly|weekdays)\b|\b(?:every|each)\s+(?:morning|afternoon|evening)\b|毎(?:日|週|月|朝|晩|平日)|定期的に|繰り返し/.test(text);
 const action=/\b(?:do|send|summari[sz]e|report|review|check|update|notify|remind|prepare|create|post|tell|scan|track|run)\b|(?:要約|まとめ|報告|確認|通知|知らせ|送信|作成|レビュー|点検|追跡|実行)/.test(text);
 return cadence&&action;
}

async function hash(text){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()));
 return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
}

export async function createRecurringAutomationOffer(db,{orgId,userId,login,channel,threadId,sourceMessageId,prompt,now=new Date()}){
 if(!isRecurringWorkPrompt(prompt)||!orgId||!userId||!login||!channel?.startsWith('b:')||!threadId||!sourceMessageId)return null;
 const [root,sourceMessage]=await Promise.all([getMessage(db,orgId,threadId),getMessage(db,orgId,sourceMessageId)]);
 if(!root||root.deleted_at||root.parent_id||root.channel!==channel||!sourceMessage||sourceMessage.deleted_at||sourceMessage.channel!==channel||sourceMessage.body!==prompt)return null;
 const id=crypto.randomUUID(),at=now.toISOString(),promptHash=await hash(prompt),sourceRootHash=await hash(root.body);
 const inserted=await db.prepare(`INSERT OR IGNORE INTO hx_recurring_automation_offers
   (id,org_id,user_github_id,login,channel,thread_id,source_message_id,source_root_hash,prompt,prompt_hash,state,created_at,updated_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'offered',?11,?11
     WHERE EXISTS(SELECT 1 FROM memberships WHERE org_id=?2 AND user_github_id=?3 AND LOWER(TRIM(COALESCE(role,'guest')))!='guest')
     AND EXISTS(SELECT 1 FROM businesses WHERE org_id=?2 AND 'b:'||slug=?5 AND archived_at IS NULL)
   ON CONFLICT(org_id,channel,user_github_id,prompt_hash) DO NOTHING`)
   .bind(id,orgId,String(userId),login,channel,threadId,sourceMessageId,sourceRootHash,String(prompt).slice(0,4000),promptHash,at).run();
 if(!inserted.meta?.changes)return null;
 return {id};
}

export async function readRecurringAutomationOffer(db,{orgId,userId,id}){
 return db.prepare('SELECT * FROM hx_recurring_automation_offers WHERE org_id=?1 AND id=?2')
   .bind(orgId,id).first();
}

export async function markRecurringAutomationOffer(db,{orgId,userId,id,state,workflowId=null,now=new Date()}){
 if(!['declined','created'].includes(state))return false;
 const result=await db.prepare(`UPDATE hx_recurring_automation_offers SET state=?1,workflow_id=?2,updated_at=?3
   WHERE org_id=?4 AND id=?5 AND state='offered'`)
   .bind(state,workflowId,now.toISOString(),orgId,id).run();
 return Boolean(result.meta?.changes);
}

export async function respondToRecurringAutomationOffer(env,request,orgId,who,{id,action,timezone='UTC'},{generate=generateWorkflow}={}){
 if(!['accept','decline'].includes(action))return {error:'Choose whether to set up this Automation.',status:400};
 if(await getMode(env.DB,orgId)!=='harness')return {error:'Automation suggestions are available in Harness mode.',status:404};
 const offer=await readRecurringAutomationOffer(env.DB,{orgId,id});
 if(!offer)return {error:'No such Automation suggestion.',status:404};
 const userId=who.session.github_id;
 if(!await mayUseConversation(env.DB,orgId,String(userId),offer.channel))return {error:'No such room.',status:404};
 if(offer.state==='declined')return action==='decline'?{offer:{id:offer.id,state:'declined'},replay:true}:{error:'This Automation suggestion was already answered.',status:409};
 if(offer.state==='created'&&offer.workflow_id){
  const workflow=await getWorkflow(env.DB,orgId,offer.workflow_id,{viewerId:String(userId)});
  return workflow?{offer:{id:offer.id,state:'created'},workflow,replay:true}:{error:'The Automation is no longer available.',status:404};
 }
 if(offer.state!=='offered')return {error:'This Automation suggestion was already answered.',status:409};
 if(action==='decline'){
  await markRecurringAutomationOffer(env.DB,{orgId,userId,id:offer.id,state:'declined'});
  return {offer:{id:offer.id,state:'declined'}};
 }
 const root=await getMessage(env.DB,orgId,offer.thread_id);
 if(!root||root.deleted_at||root.parent_id||root.channel!==offer.channel)return {error:'The source conversation is no longer available.',status:409};
 if(await hash(root.body)!==offer.source_root_hash)return {error:'The source conversation changed. Ask again to get a new suggestion.',status:409};
 const sourceMessage=await getMessage(env.DB,orgId,offer.source_message_id);
 if(!sourceMessage||sourceMessage.deleted_at||sourceMessage.channel!==offer.channel||sourceMessage.body!==offer.prompt)return {error:'The recurring-work request changed. Ask again to get a new suggestion.',status:409};
 const made=await generate(env,request,orgId,who,{prompt:offer.prompt,channel:offer.channel,timezone,requestId:`automation-offer-${offer.id}`,captureSource:false,useModel:true},{enableAfterConsent:true,sourceOverride:{channel:root.channel,threadId:root.id,body:root.body}});
 if(made.response)return {response:made.response};
 if(made.error)return made;
 await markRecurringAutomationOffer(env.DB,{orgId,userId,id:offer.id,state:'created',workflowId:made.workflow.id});
 return {offer:{id:offer.id,state:'created'},...made};
}
