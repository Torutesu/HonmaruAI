import { aad, openField } from '../secrets.js';
import { actorInRoom } from './roomHooks.js';

const fail=(error,status)=>({error,status});
const currentMembership=`EXISTS(SELECT 1 FROM businesses b
 JOIN hx_room_access a ON a.org_id=b.org_id AND a.channel=?2 AND a.deleted_at IS NULL
 JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2
 JOIN users u ON u.login=c.login
 JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=u.github_id
 WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL
 AND u.github_id=?3 AND lower(trim(coalesce(m.role,'member')))!='guest' AND m.created_at||'/'||c.added_at=?4)`;
const validRequestId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validCustomerKey=value=>typeof value==='string'&&/^(?:customer-(?:[a-f0-9]{10}|[a-f0-9]{32})|unknown)$/.test(value);

export async function sendLineInboxReply(env,{orgId,channel,actorId,hookId,customerKey,requestId,body}) {
 const db=env.DB,clean=typeof body==='string'?body.trim():'';
 if(typeof hookId!=='string'||!/^[0-9a-f-]{36}$/i.test(hookId)||!validRequestId(requestId)||!validCustomerKey(customerKey)||clean.length<1||clean.length>5000)return fail('A reply, connection, customer, and unique request ID are required.',400);
 if(customerKey==='unknown')return fail('This LINE message has no replyable recipient.',400);
 const current=await actorInRoom(db,orgId,channel,actorId);
 if(current.error)return current;
 const hook=await db.prepare(`SELECT h.version,l.channel_access_token FROM hx_room_hooks h
   JOIN hx_line_room_hooks l ON l.org_id=h.org_id AND l.id=h.id
   WHERE h.org_id=?1 AND h.channel=?2 AND h.id=?3 AND h.revoked_at IS NULL`)
   .bind(orgId,channel,hookId).first();
 if(!hook)return fail('No active LINE connection was found.',404);
 const token=await openField(hook.channel_access_token,aad.lineRoomHookAccessToken(orgId,hookId),orgId);
 if(!token)return fail('Add a LINE channel access token before sending replies.',409);
 const recipient=await db.prepare(`SELECT target_type,target_fingerprint,target_ciphertext FROM hx_line_inbox_customers
   WHERE org_id=?1 AND channel=?2 AND hook_id=?3 AND customer_key=?4`)
   .bind(orgId,channel,hookId,customerKey).first();
 if(!recipient)return fail('This customer does not have a verified LINE reply destination.',409);
 const rawTarget=await openField(recipient.target_ciphertext,aad.lineInboxCustomerTarget(orgId,hookId,customerKey),orgId);
 let target;try{target=JSON.parse(rawTarget||'null')}catch{return fail('The encrypted LINE reply destination is unavailable.',409)}
 if(!target||target.type!==recipient.target_type||!['user','group','room'].includes(target.type)||typeof target.id!=='string'||!target.id)return fail('The encrypted LINE reply destination is unavailable.',409);
 const id=crypto.randomUUID(),at=new Date().toISOString();
 const inserted=await db.prepare(`INSERT OR IGNORE INTO hx_line_inbox_replies
   (id,org_id,channel,hook_id,customer_key,request_id,body,status,created_by,created_at,updated_at)
   SELECT ?5,?1,?2,?6,?7,?8,?9,'sending',?3,?10,?10
   WHERE EXISTS(SELECT 1 FROM hx_room_hooks h JOIN hx_line_room_hooks l ON l.id=h.id AND l.org_id=h.org_id
     WHERE h.org_id=?1 AND h.channel=?2 AND h.id=?6 AND h.version=?11 AND h.revoked_at IS NULL
       AND l.channel_access_token IS NOT NULL)
     AND EXISTS(SELECT 1 FROM hx_line_inbox_customers c WHERE c.org_id=?1 AND c.channel=?2 AND c.hook_id=?6
       AND c.customer_key=?7 AND c.target_fingerprint=?12)
     AND ${currentMembership}`)
   .bind(orgId,channel,String(actorId),current.actor.membership,id,hookId,customerKey,requestId,clean,at,hook.version,recipient.target_fingerprint).run();
 if(!inserted.meta?.changes){
  const prior=await db.prepare(`SELECT id,status,body,created_at AS createdAt FROM hx_line_inbox_replies
    WHERE org_id=?1 AND hook_id=?2 AND request_id=?3`).bind(orgId,hookId,requestId).first();
  if(prior?.status==='sent')return {reply:{...prior,direction:'outbound',deliveryStatus:'sent'},replay:true};
  if(prior)return fail('This reply attempt may already have reached LINE. Check the conversation before sending again.',409);
  return fail('LINE connection or room membership changed. Reload before sending.',409);
 }
 let response;
 try{
  response=await fetch('https://api.line.me/v2/bot/message/push',{
   method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
   body:JSON.stringify({to:target.id,messages:[{type:'text',text:clean}]}),
  });
 }catch{
  await db.prepare(`UPDATE hx_line_inbox_replies SET status='unknown',updated_at=?1 WHERE org_id=?2 AND id=?3 AND status='sending'`).bind(new Date().toISOString(),orgId,id).run().catch(()=>{});
  return fail('LINE did not confirm the send. Check the conversation before sending again.',502);
 }
 if(!response.ok){
  const unknown=response.status>=500;
  await db.prepare(`UPDATE hx_line_inbox_replies SET status=?1,updated_at=?2 WHERE org_id=?3 AND id=?4 AND status='sending'`)
   .bind(unknown?'unknown':'failed',new Date().toISOString(),orgId,id).run().catch(()=>{});
  return fail(unknown?'LINE did not confirm the send. Check the conversation before sending again.':'LINE rejected the reply. Check the channel token and recipient before trying again.',502);
 }
 await response.body?.cancel().catch(()=>{});
 const providerRequestId=response.headers.get('x-line-request-id');
 const settled=await db.prepare(`UPDATE hx_line_inbox_replies SET status='sent',provider_request_id=?1,updated_at=?2
   WHERE org_id=?3 AND id=?4 AND status='sending'`)
   .bind(providerRequestId,new Date().toISOString(),orgId,id).run().catch(()=>null);
 if(!settled?.meta?.changes)return {reply:{id,body:clean,createdAt:at,direction:'outbound',deliveryStatus:'unknown'},pending:true};
 return {reply:{id,body:clean,createdAt:at,direction:'outbound',deliveryStatus:'sent'},requestId:providerRequestId||null};
}
