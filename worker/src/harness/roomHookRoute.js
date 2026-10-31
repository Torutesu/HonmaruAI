import { drainRoomHookDispatch } from './roomHookDispatch.js';
import { enforce } from '../ratelimit.js';
import { authenticateLineRoomHook, authenticateRoomHook, receiveRoomHookEvent } from './roomHooks.js';
import { readRoomWebhookInput } from './roomWebhookInput.js';
import { broadcastRoomHookMessage } from './roomHookBroadcast.js';
import { lineMessagesFromWebhook, verifyLineWebhookSignature } from './lineWebhook.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: {'content-type':'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff'},
});

async function readBoundedBody(request, limit) {
  const reader=request.body?.getReader();
  if(!reader)return new Uint8Array();
  const chunks=[];
  let size=0;
  for(;;) {
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>limit){await reader.cancel().catch(()=>{});return null;}
    chunks.push(value);
  }
  const body=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return body;
}

export async function handleRoomHook(request, env, url, context = {}) {
  const lineMatch=url.pathname.match(/^\/hooks\/line\/([0-9a-f-]{36})$/i);
  if(lineMatch) {
    if(request.method!=='POST')return json({message:'Method not allowed.'},405);
    const limited=await enforce(env,request,'webhooks/line');
    if(limited)return limited;
    const contentLength=Number(request.headers.get('content-length')||0);
    if(Number.isFinite(contentLength)&&contentLength>1_048_576)return json({message:'The LINE webhook body is too large.'},413);
    let rawBody;
    try{rawBody=await readBoundedBody(request,1_048_576);}catch{return json({message:'Unreadable LINE webhook body.'},400);}
    if(!rawBody)return json({message:'The LINE webhook body is too large.'},413);
    const hook=await authenticateLineRoomHook(env.DB,lineMatch[1],rawBody,request.headers.get('x-line-signature'),verifyLineWebhookSignature);
    if(!hook)return json({message:'Invalid LINE webhook signature or inactive room.'},401);
    let payload;
    try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody)); }
    catch { return json({message:'Unreadable LINE webhook body.'},400); }
    const parsed=await lineMessagesFromWebhook(hook.id,payload);
    if(parsed.error)return json({message:parsed.error},parsed.status);
    const deliveryIds=[];
    let received=0;
    let duplicates=0;
    for(const item of parsed.messages) {
      const result=await receiveRoomHookEvent(env.DB,hook,item,{dispatch:false});
      if(result.error)return json({message:result.error},result.status);
      deliveryIds.push(result.messageId);
      if(result.replay)duplicates++;else received++;
    }
    const broadcast=Promise.all(deliveryIds.map(messageId=>broadcastRoomHookMessage(env,hook.orgId,hook.channel,messageId).catch(()=>{})));
    if(typeof context.waitUntil==='function')context.waitUntil(broadcast);else await broadcast;
    return json({received,duplicates,ignored:parsed.ignored});
  }
  if (!url.pathname.startsWith('/hooks/rooms/')) return null;
  if (request.method !== 'POST') return json({message:'Method not allowed.'},405);
  const limited = await enforce(env,request,'chat');
  if (limited) return limited;
  const id = url.pathname.slice('/hooks/rooms/'.length);
  const secret = /^Bearer (rh_[0-9a-f]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!/^[0-9a-f-]{36}$/.test(id) || !secret) return json({message:'Invalid webhook credentials.'},401);
  const hook = await authenticateRoomHook(env.DB,id,secret);
  if (!hook) return json({message:'Invalid webhook credentials.'},401);
  const input = await readRoomWebhookInput(request);
  if (input.error) return json({message:input.error},input.status);
  const result = await receiveRoomHookEvent(env.DB,hook,input);
  // Replays can repair a missed live update; clients replace messages by ID.
  // A failed broadcast never rolls back an already committed event receipt.
  if (!result.error) await Promise.all([
    broadcastRoomHookMessage(env,hook.orgId,hook.channel,result.messageId).catch(() => {}),
    drainRoomHookDispatch(env,{orgId:hook.orgId,messageId:result.messageId,limit:1}).catch(() => {}),
  ]);
  return result.error ? json({message:result.error},result.status) : json(result,result.replay?200:201);
}
